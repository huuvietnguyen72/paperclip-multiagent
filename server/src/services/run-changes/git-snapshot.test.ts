import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RUN_CHANGES_LIMITS } from "@paperclipai/shared";
import { captureSnapshot, diffSnapshots, isCollapsedByDefault, type Snapshot } from "./git-snapshot.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function repo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "run-changes-"));
  dirs.push(dir);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "test@example.test");
  git(dir, "config", "user.name", "Test");
  writeFileSync(path.join(dir, "keep.txt"), "one\ntwo\nthree\n");
  writeFileSync(path.join(dir, "old-name.txt"), "rename me\nsecond line\nthird line\n");
  writeFileSync(path.join(dir, "gone.txt"), "delete me\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

async function snap(cwd: string): Promise<Snapshot> {
  const result = await captureSnapshot(cwd);
  if (!result.ok) throw new Error(`snapshot failed: ${result.reason}`);
  return result.snapshot;
}

const noRedact = (text: string) => text;

describe("git snapshots", () => {
  it("captures modified, added, deleted and renamed files", async () => {
    const dir = repo();
    const start = await snap(dir);
    writeFileSync(path.join(dir, "keep.txt"), "one\nTWO\nthree\nfour\n");
    writeFileSync(path.join(dir, "new.txt"), "a\nb\n");
    unlinkSync(path.join(dir, "gone.txt"));
    renameSync(path.join(dir, "old-name.txt"), path.join(dir, "new-name.txt"));
    const end = await snap(dir);
    const diff = await diffSnapshots(dir, start, end, noRedact);
    const byPath = new Map(diff.files.map((file) => [file.path, file]));
    expect(byPath.get("keep.txt")).toMatchObject({ status: "modified", additions: 2, deletions: 1, binary: false });
    expect(byPath.get("new.txt")).toMatchObject({ status: "added", additions: 2, deletions: 0 });
    expect(byPath.get("gone.txt")).toMatchObject({ status: "deleted", additions: 0, deletions: 1 });
    expect(byPath.get("new-name.txt")).toMatchObject({ status: "renamed", oldPath: "old-name.txt" });
    expect(diff.additions).toBe(4);
    expect(diff.patches.get("keep.txt")).toContain("-two");
    expect(diff.patches.get("keep.txt")).toContain("+TWO");
  });

  it("includes commits made during the run", async () => {
    const dir = repo();
    const start = await snap(dir);
    writeFileSync(path.join(dir, "committed.txt"), "x\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "agent commit");
    const end = await snap(dir);
    expect(end.head).not.toBe(start.head);
    const diff = await diffSnapshots(dir, start, end, noRedact);
    expect(diff.files.map((file) => file.path)).toEqual(["committed.txt"]);
  });

  it("ignores gitignored files", async () => {
    const dir = repo();
    writeFileSync(path.join(dir, ".gitignore"), ".env\n");
    git(dir, "add", ".gitignore");
    git(dir, "commit", "-q", "-m", "ignore");
    const start = await snap(dir);
    writeFileSync(path.join(dir, ".env"), "SECRET=1\n");
    const end = await snap(dir);
    const diff = await diffSnapshots(dir, start, end, noRedact);
    expect(diff.files).toEqual([]);
  });

  it("does not touch the agent index, HEAD or branch", async () => {
    const dir = repo();
    writeFileSync(path.join(dir, "keep.txt"), "staged\n");
    git(dir, "add", "keep.txt");
    writeFileSync(path.join(dir, "unstaged.txt"), "u\n");
    const cachedBefore = git(dir, "diff", "--cached");
    const statusBefore = git(dir, "status", "--porcelain");
    const headBefore = git(dir, "rev-parse", "HEAD");
    const start = await snap(dir);
    const end = await snap(dir);
    await diffSnapshots(dir, start, end, noRedact);
    expect(git(dir, "diff", "--cached")).toBe(cachedBefore);
    expect(git(dir, "status", "--porcelain")).toBe(statusBefore);
    expect(git(dir, "rev-parse", "HEAD")).toBe(headBefore);
    expect(git(dir, "symbolic-ref", "--short", "HEAD").trim()).toBe("main");
    expect(start.branch).toBe("main");
  });

  it("round-trips unicode and space paths", async () => {
    const dir = repo();
    const start = await snap(dir);
    mkdirSync(path.join(dir, "docs"));
    writeFileSync(path.join(dir, "docs", "Báo cáo cuối kỳ.md"), "# Tiêu đề\n");
    const end = await snap(dir);
    const diff = await diffSnapshots(dir, start, end, noRedact);
    expect(diff.files.map((file) => file.path)).toEqual(["docs/Báo cáo cuối kỳ.md"]);
    expect(diff.patches.get("docs/Báo cáo cuối kỳ.md")).toContain("+# Tiêu đề");
  });

  it("marks binary files without a patch", async () => {
    const dir = repo();
    const start = await snap(dir);
    writeFileSync(path.join(dir, "image.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x00, 0xff]));
    const end = await snap(dir);
    const diff = await diffSnapshots(dir, start, end, noRedact);
    expect(diff.files[0]).toMatchObject({ path: "image.png", binary: true, additions: 0, deletions: 0 });
    expect(diff.patches.get("image.png")).toBeNull();
  });

  it("truncates big files and enforces the per-run file limit", async () => {
    const dir = repo();
    const start = await snap(dir);
    writeFileSync(path.join(dir, "big.txt"), Array.from({ length: 3000 }, (_, index) => `line ${index}`).join("\n") + "\n");
    mkdirSync(path.join(dir, "many"));
    for (let index = 0; index < RUN_CHANGES_LIMITS.files + 4; index += 1) {
      writeFileSync(path.join(dir, "many", `f${String(index).padStart(3, "0")}.txt`), `${index}\n`);
    }
    const end = await snap(dir);
    const diff = await diffSnapshots(dir, start, end, noRedact);
    const big = diff.files.find((file) => file.path === "big.txt")!;
    expect(big.truncated).toBe(true);
    expect(big.additions).toBe(3000);
    expect(diff.patches.get("big.txt")!.split("\n").length).toBeLessThanOrEqual(RUN_CHANGES_LIMITS.fileLines + 1);
    expect(diff.files).toHaveLength(RUN_CHANGES_LIMITS.files + 5);
    expect([...diff.patches.keys()]).toHaveLength(RUN_CHANGES_LIMITS.files);
  });

  it("collapses lockfiles and generated files by default", () => {
    expect(isCollapsedByDefault("package-lock.json", "")).toBe(true);
    expect(isCollapsedByDefault("apps/web/pnpm-lock.yaml", "")).toBe(true);
    expect(isCollapsedByDefault("apps/web/src/api/schema.d.ts", "@@ -0,0 +1,3 @@\n+/**\n+ * This file was auto-generated by openapi-typescript.")).toBe(true);
    expect(isCollapsedByDefault("src/app.ts", "@@ -1 +1 @@\n-a\n+b")).toBe(false);
  });

  it("redacts secrets in patches", async () => {
    const dir = repo();
    const start = await snap(dir);
    writeFileSync(path.join(dir, "config.ts"), "export const key = 'sk-live-SECRET';\n");
    const end = await snap(dir);
    const diff = await diffSnapshots(dir, start, end, (text) => text.replaceAll("sk-live-SECRET", "***REDACTED***"));
    expect(diff.patches.get("config.ts")).toContain("***REDACTED***");
    expect(diff.patches.get("config.ts")).not.toContain("sk-live-SECRET");
  });

  it("returns not_git for a plain directory", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "run-changes-plain-"));
    dirs.push(dir);
    const result = await captureSnapshot(dir);
    expect(result).toEqual({ ok: false, reason: "not_git" });
  });

  it("returns timeout when git does not finish in time", async () => {
    const dir = repo();
    const result = await captureSnapshot(dir, { timeoutMs: 1 });
    expect(result).toMatchObject({ ok: false, reason: "timeout" });
  });
});
