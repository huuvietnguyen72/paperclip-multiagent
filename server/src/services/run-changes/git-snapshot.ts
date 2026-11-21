import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { RUN_CHANGES_LIMITS, type RunChangeFile, type RunChangeFileStatus } from "@paperclipai/shared";

/**
 * Git snapshots of a workspace's working tree, taken without touching the
 * agent's own git state: a private temporary index (GIT_INDEX_FILE) is filled
 * from HEAD plus `git add -A`, and only the resulting tree object is kept.
 */

export type Snapshot = { head: string | null; tree: string; branch: string | null };
export type SnapshotResult =
  | { ok: true; snapshot: Snapshot }
  | { ok: false; reason: "not_git" | "timeout" | "error"; detail?: string };

const MAX_BUFFER = 64 * 1024 * 1024;
const LOCKFILES = new Set(["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb", "Cargo.lock", "poetry.lock"]);
const GENERATED_MARKER = /@generated|auto-generated|DO NOT EDIT/i;

class GitCommandError extends Error {
  constructor(message: string, readonly aborted: boolean) {
    super(message);
  }
}

function git(cwd: string, args: string[], opts: { env?: NodeJS.ProcessEnv; signal?: AbortSignal } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, {
      cwd,
      env: { ...process.env, ...opts.env, GIT_OPTIONAL_LOCKS: "0" },
      signal: opts.signal,
      maxBuffer: MAX_BUFFER,
      encoding: "utf8",
    }, (error, stdout, stderr) => {
      if (error) {
        const aborted = opts.signal?.aborted === true || (error as NodeJS.ErrnoException).code === "ABORT_ERR";
        reject(new GitCommandError(String(stderr || error.message).trim(), aborted));
        return;
      }
      resolve(stdout);
    });
  });
}

async function optional(promise: Promise<string>): Promise<string | null> {
  try {
    const value = (await promise).trim();
    return value || null;
  } catch (error) {
    if (error instanceof GitCommandError && error.aborted) throw error;
    return null;
  }
}

export async function captureSnapshot(cwd: string, opts: { timeoutMs?: number } = {}): Promise<SnapshotResult> {
  const signal = AbortSignal.timeout(opts.timeoutMs ?? RUN_CHANGES_LIMITS.snapshotTimeoutMs);
  const indexFile = path.join(tmpdir(), `paperclip-run-changes-${randomUUID()}.index`);
  try {
    let root: string;
    try {
      root = (await git(cwd, ["rev-parse", "--show-toplevel"], { signal })).trim();
    } catch (error) {
      if (error instanceof GitCommandError && error.aborted) return { ok: false, reason: "timeout" };
      return { ok: false, reason: "not_git" };
    }
    const head = await optional(git(root, ["rev-parse", "--verify", "-q", "HEAD"], { signal }));
    const branch = await optional(git(root, ["symbolic-ref", "--short", "-q", "HEAD"], { signal }));
    const env = { GIT_INDEX_FILE: indexFile };
    await git(root, head ? ["read-tree", head] : ["read-tree", "--empty"], { env, signal });
    await git(root, ["add", "-A"], { env, signal });
    const tree = (await git(root, ["write-tree"], { env, signal })).trim();
    return { ok: true, snapshot: { head, tree, branch } };
  } catch (error) {
    if (error instanceof GitCommandError && error.aborted) return { ok: false, reason: "timeout" };
    if (signal.aborted) return { ok: false, reason: "timeout" };
    return { ok: false, reason: "error", detail: error instanceof Error ? error.message : String(error) };
  } finally {
    await rm(indexFile, { force: true }).catch(() => undefined);
  }
}

export function isCollapsedByDefault(filePath: string, patchHead: string): boolean {
  if (LOCKFILES.has(path.posix.basename(filePath))) return true;
  const firstLines = patchHead.split("\n").slice(0, 6).join("\n");
  return GENERATED_MARKER.test(firstLines);
}

function statusFromLetter(letter: string): RunChangeFileStatus {
  if (letter.startsWith("A")) return "added";
  if (letter.startsWith("D")) return "deleted";
  if (letter.startsWith("R")) return "renamed";
  return "modified";
}

function parseNameStatus(output: string): Array<{ status: RunChangeFileStatus; path: string; oldPath: string | null }> {
  const parts = output.split("\0");
  const entries: Array<{ status: RunChangeFileStatus; path: string; oldPath: string | null }> = [];
  for (let index = 0; index < parts.length;) {
    const letter = parts[index++];
    if (!letter) continue;
    if (letter.startsWith("R") || letter.startsWith("C")) {
      const oldPath = parts[index++]!;
      const newPath = parts[index++]!;
      entries.push({ status: letter.startsWith("R") ? "renamed" : "added", path: newPath, oldPath: letter.startsWith("R") ? oldPath : null });
    } else {
      entries.push({ status: statusFromLetter(letter), path: parts[index++]!, oldPath: null });
    }
  }
  return entries;
}

function parseNumstat(output: string): Map<string, { additions: number; deletions: number; binary: boolean }> {
  const parts = output.split("\0");
  const stats = new Map<string, { additions: number; deletions: number; binary: boolean }>();
  for (let index = 0; index < parts.length;) {
    const record = parts[index++];
    if (!record) continue;
    const [added, deleted, inlinePath] = record.split("\t");
    let filePath = inlinePath ?? "";
    if (filePath === "") {
      index += 1; // old path of a rename
      filePath = parts[index++] ?? "";
    }
    const binary = added === "-" && deleted === "-";
    stats.set(filePath, {
      additions: binary ? 0 : Number(added) || 0,
      deletions: binary ? 0 : Number(deleted) || 0,
      binary,
    });
  }
  return stats;
}

function boundPatch(patch: string): { text: string; truncated: boolean } {
  const lines = patch.split("\n");
  let text = patch;
  let truncated = false;
  if (lines.length > RUN_CHANGES_LIMITS.fileLines) {
    text = lines.slice(0, RUN_CHANGES_LIMITS.fileLines).join("\n");
    truncated = true;
  }
  if (Buffer.byteLength(text, "utf8") > RUN_CHANGES_LIMITS.fileBytes) {
    text = Buffer.from(text, "utf8").subarray(0, RUN_CHANGES_LIMITS.fileBytes).toString("utf8");
    truncated = true;
  }
  return { text, truncated };
}

export async function diffSnapshots(
  cwd: string,
  start: Snapshot,
  end: Snapshot,
  redact: (text: string) => string,
): Promise<{ files: RunChangeFile[]; patches: Map<string, string | null>; additions: number; deletions: number }> {
  const root = (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
  const range = [start.tree, end.tree];
  const nameStatus = parseNameStatus(await git(root, ["diff", "--name-status", "-z", "-M", ...range]));
  const numstat = parseNumstat(await git(root, ["diff", "--numstat", "-z", "-M", ...range]));

  const files: RunChangeFile[] = [];
  const patches = new Map<string, string | null>();
  let additions = 0;
  let deletions = 0;
  let totalBytes = 0;

  for (const [position, entry] of nameStatus.entries()) {
    const stat = numstat.get(entry.path) ?? { additions: 0, deletions: 0, binary: false };
    additions += stat.additions;
    deletions += stat.deletions;
    const file: RunChangeFile = {
      path: entry.path,
      oldPath: entry.oldPath,
      status: entry.status,
      additions: stat.additions,
      deletions: stat.deletions,
      binary: stat.binary,
      truncated: false,
      collapsedByDefault: isCollapsedByDefault(entry.path, ""),
    };
    files.push(file);
    if (position >= RUN_CHANGES_LIMITS.files) continue;
    if (stat.binary) {
      patches.set(entry.path, null);
      continue;
    }
    if (totalBytes >= RUN_CHANGES_LIMITS.totalBytes) {
      file.truncated = true;
      continue;
    }
    const pathspec = entry.oldPath ? [entry.oldPath, entry.path] : [entry.path];
    const raw = await git(root, ["diff", "-M", "--patch", "--no-color", "--no-ext-diff", ...range, "--", ...pathspec]);
    const hunkStart = raw.indexOf("\n@@");
    const { text, truncated } = boundPatch(redact(raw));
    file.truncated = truncated;
    file.collapsedByDefault = isCollapsedByDefault(entry.path, hunkStart >= 0 ? raw.slice(hunkStart + 1) : "");
    totalBytes += Buffer.byteLength(text, "utf8");
    patches.set(entry.path, text);
  }
  return { files, patches, additions, deletions };
}
