import { execFile } from "node:child_process";
import { PROJECT_CODE_VIEW_GIT_TIMEOUT_MS, type ProjectCodeViewResult } from "@paperclipai/shared";

/**
 * Git operations for the project "Code" tab. Only reads and fast-forward merges:
 * never reset, stash, checkout or clean, so a local copy with its own work is left alone.
 */

export interface CloneHead {
  branch: string | null;
  head: string | null;
  subject: string | null;
}

export interface CloneRefresh {
  result: ProjectCodeViewResult;
  before: string | null;
  after: string | null;
  error: string | null;
}

const MAX_ERROR_CHARS = 500;

function git(cwd: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", ["-C", cwd, ...args], {
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    }, (error, stdout, stderr) => {
      if (error) {
        const firstLine = String(stderr || error.message).trim().split("\n")[0] ?? "git failed";
        reject(new Error(firstLine.slice(0, MAX_ERROR_CHARS)));
        return;
      }
      resolve(String(stdout).trim());
    });
  });
}

async function tryGit(cwd: string, args: string[], timeoutMs: number): Promise<string | null> {
  try {
    return await git(cwd, args, timeoutMs);
  } catch {
    return null;
  }
}

export async function readCloneHead(cwd: string, opts: { timeoutMs?: number } = {}): Promise<CloneHead> {
  const timeoutMs = opts.timeoutMs ?? PROJECT_CODE_VIEW_GIT_TIMEOUT_MS;
  const head = await tryGit(cwd, ["rev-parse", "--short", "HEAD"], timeoutMs);
  if (!head) return { branch: null, head: null, subject: null };
  const [branch, subject] = await Promise.all([
    tryGit(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"], timeoutMs),
    tryGit(cwd, ["log", "-1", "--format=%s"], timeoutMs),
  ]);
  return { branch: branch || null, head, subject: subject ?? null };
}

export async function refreshClone(cwd: string, opts: { timeoutMs?: number } = {}): Promise<CloneRefresh> {
  const timeoutMs = opts.timeoutMs ?? PROJECT_CODE_VIEW_GIT_TIMEOUT_MS;
  const before = await tryGit(cwd, ["rev-parse", "HEAD"], timeoutMs);
  const done = (result: ProjectCodeViewResult, after: string | null = before, error: string | null = null): CloneRefresh =>
    ({ result, before, after, error });
  try {
    await git(cwd, ["fetch", "--quiet", "origin"], timeoutMs);
    if (await tryGit(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"], timeoutMs) === null) return done("skipped_detached");
    if (await tryGit(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], timeoutMs) === null) {
      return done("skipped_detached");
    }
    if ((await git(cwd, ["status", "--porcelain"], timeoutMs)).length > 0) return done("skipped_dirty");
    if (await tryGit(cwd, ["merge-base", "--is-ancestor", "HEAD", "@{upstream}"], timeoutMs) === null) return done("diverged");
    await git(cwd, ["merge", "--ff-only", "--quiet", "@{upstream}"], timeoutMs);
    const after = await git(cwd, ["rev-parse", "HEAD"], timeoutMs);
    return done(after === before ? "up_to_date" : "updated", after);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return done("error", before, (message || "git failed").slice(0, MAX_ERROR_CHARS));
  }
}
