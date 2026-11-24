import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readCloneHead, refreshClone } from "./git.js";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "init.defaultBranch=main", ...args], {
    cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }).trim();

const roots: string[] = [];

function fixture() {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "code-view-git-")));
  roots.push(root);
  const origin = path.join(root, "origin.git");
  const seed = path.join(root, "seed");
  const view = path.join(root, "view");
  git(root, "init", "--bare", "-q", origin);
  git(root, "clone", "-q", origin, seed);
  writeFileSync(path.join(seed, "README.md"), "hello\n");
  git(seed, "add", "-A");
  git(seed, "commit", "-q", "-m", "init");
  git(seed, "push", "-q", "origin", "HEAD:main");
  git(root, "clone", "-q", "--branch", "main", origin, view);
  const push = (file: string, message: string) => {
    writeFileSync(path.join(seed, file), `${message}\n`);
    git(seed, "add", "-A");
    git(seed, "commit", "-q", "-m", message);
    git(seed, "push", "-q", "origin", "HEAD:main");
  };
  return { root, origin, seed, view, push, head: () => git(view, "rev-parse", "HEAD") };
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("readCloneHead", () => {
  it("reads the branch, short sha and subject of a clone", async () => {
    const f = fixture();
    const head = await readCloneHead(f.view);
    expect(head.branch).toBe("main");
    expect(head.head).toMatch(/^[0-9a-f]{7,}$/);
    expect(f.head().startsWith(head.head!)).toBe(true);
    expect(head.subject).toBe("init");
  });

  it("returns nulls outside a git repository", async () => {
    const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "code-view-plain-")));
    roots.push(dir);
    expect(await readCloneHead(dir)).toEqual({ branch: null, head: null, subject: null });
  });
});

describe("refreshClone", () => {
  it("fast-forwards to new remote commits, then reports up to date", async () => {
    const f = fixture();
    f.push("new.ts", "add new");
    const first = await refreshClone(f.view);
    expect(first.result).toBe("updated");
    expect(first.after).not.toBe(first.before);
    expect(existsSync(path.join(f.view, "new.ts"))).toBe(true);
    const second = await refreshClone(f.view);
    expect(second).toMatchObject({ result: "up_to_date", error: null });
    expect(second.after).toBe(second.before);
  });

  it("does not touch a clone with local changes", async () => {
    const f = fixture();
    const before = f.head();
    writeFileSync(path.join(f.view, "scratch.txt"), "mine\n");
    f.push("new.ts", "add new");
    const result = await refreshClone(f.view);
    expect(result.result).toBe("skipped_dirty");
    expect(f.head()).toBe(before);
    expect(existsSync(path.join(f.view, "scratch.txt"))).toBe(true);
  });

  it("skips a detached checkout", async () => {
    const f = fixture();
    git(f.view, "checkout", "-q", "--detach");
    expect((await refreshClone(f.view)).result).toBe("skipped_detached");
  });

  it("refuses to merge when the clone has its own commits", async () => {
    const f = fixture();
    writeFileSync(path.join(f.view, "local.ts"), "local\n");
    git(f.view, "add", "-A");
    git(f.view, "commit", "-q", "-m", "local work");
    const local = f.head();
    f.push("new.ts", "remote work");
    expect((await refreshClone(f.view)).result).toBe("diverged");
    expect(f.head()).toBe(local);
  });

  it("reports an error when the remote is unreachable", async () => {
    const f = fixture();
    git(f.view, "remote", "set-url", "origin", path.join(f.root, "missing.git"));
    const result = await refreshClone(f.view);
    expect(result.result).toBe("error");
    expect(result.error).toBeTruthy();
    expect(result.error!.length).toBeLessThanOrEqual(500);
  });
});
