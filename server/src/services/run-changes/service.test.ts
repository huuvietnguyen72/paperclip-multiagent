import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  agents, companies, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, executionWorkspaces, heartbeatRunChanges,
  heartbeatRuns, issues, type Db,
} from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { resolveExternalTestDatabaseUrl } from "../../__tests__/helpers/external-test-database.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { createRunChangesService } from "./service.js";

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_RUN_CHANGES_TEST_DATABASE_URL");
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skipping run changes database tests: ${support.reason}`);

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function gitRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "run-changes-svc-"));
  dirs.push(dir);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.test");
  git("config", "user.name", "Test");
  writeFileSync(path.join(dir, "app.ts"), "export const a = 1;\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  return dir;
}

const ACP_LOG = JSON.stringify({
  ts: "2026-11-22T10:00:00.000Z", stream: "stdout",
  chunk: [
    { type: "acpx.tool_call", name: "Terminal", toolCallId: "t1", status: "pending", tag: "tool_call" },
    { type: "acpx.tool_call", name: "sed -i s/1/2/ app.ts", toolCallId: "t1", tag: "tool_call_update" },
  ].map((event) => JSON.stringify(event)).join("\n") + "\n",
});

describePostgres("run changes service", () => {
  let db: Db;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;

  beforeAll(async () => {
    if (!external) database = await startEmbeddedPostgresTestDatabase("paperclip-run-changes-");
    db = createDb(external ?? database!.connectionString, { maxConnections: 6 });
    if (external) {
      db.$client.options.onnotice = () => {};
      await db.execute(sql`truncate companies cascade`);
    }
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await database?.cleanup(); });

  const service = () => createRunChangesService(db, { readRunLog: async () => ACP_LOG });

  async function seed() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), workspaceId = randomUUID();
    const prefix = `R${companyId.slice(0, 6)}`;
    await db.insert(companies).values({ id: companyId, name: "Run changes", issuePrefix: prefix });
    await db.insert(agents).values({ id: agentId, companyId, name: "FE", role: "engineer", status: "idle", adapterType: "claude_local",
      adapterConfig: {}, runtimeConfig: { heartbeat: { enabled: false } } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Calendar", status: "in_progress", assigneeAgentId: agentId, identifier: `${prefix}-1` });
    const cwd = gitRepo();
    await db.insert(executionWorkspaces).values({ id: workspaceId, companyId, mode: "isolated_workspace", strategyType: "git_worktree",
      name: "ws", status: "active", cwd, providerType: "local_fs" });
    const newRun = async (forIssueId: string | null = issueId) => {
      const id = randomUUID();
      await db.insert(heartbeatRuns).values({ id, companyId, agentId, issueId: forIssueId, invocationSource: "on_demand",
        status: "running", runtimeMode: "legacy", startedAt: new Date() });
      return { id, companyId, agentId, startedAt: new Date() };
    };
    const finish = (runId: string) => db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, runId));
    const start = (run: { id: string; companyId: string; agentId: string; startedAt: Date }, over: Partial<{ cwd: string; kind: string; issueId: string | null }> = {}) =>
      service().recordRunStart({
        run,
        executionWorkspace: { cwd: over.cwd ?? cwd },
        persistedExecutionWorkspace: { id: workspaceId, providerType: "local_fs" },
        executionTarget: { kind: over.kind ?? "local" },
        issueId: over.issueId === undefined ? issueId : over.issueId,
      });
    const row = (runId: string) => db.select().from(heartbeatRunChanges).where(eq(heartbeatRunChanges.runId, runId)).then((rows) => rows[0]);
    return { companyId, agentId, issueId, workspaceId, cwd, newRun, finish, start, row };
  }

  it("records start and finalizes a captured run with files and commands", async () => {
    const s = await seed();
    const run = await s.newRun();
    await s.start(run);
    expect((await s.row(run.id))?.status).toBe("pending");
    writeFileSync(path.join(s.cwd, "app.ts"), "export const a = 2;\n");
    await s.finish(run.id);
    await service().finalizeRun(run.id);
    const row = (await s.row(run.id))!;
    expect(row.status).toBe("captured");
    expect(row.additions).toBe(1);
    expect(row.deletions).toBe(1);
    expect(row.files.map((file) => file.path)).toEqual(["app.ts"]);
    expect(row.commands).toEqual([{ ts: "2026-11-22T10:00:00.000Z", tool: "Terminal", text: "sed -i s/1/2/ app.ts" }]);
    const patch = await service().getFilePatch(s.companyId, run.id, "app.ts", s.issueId);
    expect(patch?.patch).toContain("+export const a = 2;");
  });

  it("records no_changes when the run changed nothing", async () => {
    const s = await seed();
    const run = await s.newRun();
    await s.start(run);
    await s.finish(run.id);
    await service().finalizeRun(run.id);
    expect((await s.row(run.id))?.status).toBe("no_changes");
  });

  it("finalize is idempotent", async () => {
    const s = await seed();
    const run = await s.newRun();
    await s.start(run);
    writeFileSync(path.join(s.cwd, "b.ts"), "b\n");
    await s.finish(run.id);
    await service().finalizeRun(run.id);
    const first = (await s.row(run.id))!;
    writeFileSync(path.join(s.cwd, "later.ts"), "not part of the run\n");
    await service().finalizeRun(run.id);
    const second = (await s.row(run.id))!;
    expect(second.files).toEqual(first.files);
    expect(second.finalizedAt?.getTime()).toBe(first.finalizedAt?.getTime());
  });

  it("skips remote and non-git workspaces", async () => {
    const s = await seed();
    const remote = await s.newRun();
    await s.start(remote, { kind: "remote" });
    expect(await s.row(remote.id)).toMatchObject({ status: "skipped", reason: "remote" });
    const plain = mkdtempSync(path.join(tmpdir(), "run-changes-plain-"));
    dirs.push(plain);
    const notGit = await s.newRun();
    await s.start(notGit, { cwd: plain });
    expect(await s.row(notGit.id)).toMatchObject({ status: "skipped", reason: "not_git" });
  });

  it("marks incomplete when the workspace was deleted", async () => {
    const s = await seed();
    const run = await s.newRun();
    await s.start(run);
    rmSync(s.cwd, { recursive: true, force: true });
    await s.finish(run.id);
    await service().finalizeRun(run.id);
    expect(await s.row(run.id)).toMatchObject({ status: "incomplete" });
  });

  it("a new run on the same workspace closes the previous pending capture and records overlap", async () => {
    const s = await seed();
    const first = await s.newRun();
    await s.start(first);
    writeFileSync(path.join(s.cwd, "first.ts"), "1\n");
    const second = await s.newRun();
    await s.start(second);
    const firstRow = (await s.row(first.id))!;
    expect(firstRow.status).toBe("captured");
    expect(firstRow.files.map((file) => file.path)).toEqual(["first.ts"]);
    expect(firstRow.overlappingRunIds).toEqual([second.id]);
    expect((await s.row(second.id))?.overlappingRunIds).toEqual([first.id]);
  });

  it("finalizePending only finalizes rows whose run is terminal", async () => {
    const s = await seed();
    const done = await s.newRun();
    await s.start(done);
    await s.finish(done.id);
    const otherWorkspace = gitRepo();
    const running = await s.newRun();
    await s.start(running, { cwd: otherWorkspace });
    const count = await service().finalizePending();
    expect(count).toBeGreaterThanOrEqual(1);
    expect((await s.row(done.id))?.status).toBe("no_changes");
    expect((await s.row(running.id))?.status).toBe("pending");
  });

  it("captures changes in repositories nested in the workspace with the directory as path prefix", async () => {
    const s = await seed();
    const workspace = mkdtempSync(path.join(tmpdir(), "run-changes-nested-"));
    dirs.push(workspace);
    const nested = gitRepo();
    execFileSync("git", ["clone", "-q", nested, path.join(workspace, "wt57")]);
    const run = await s.newRun();
    await s.start(run, { cwd: workspace });
    expect((await s.row(run.id))?.status).toBe("pending");
    writeFileSync(path.join(workspace, "wt57", "app.ts"), "export const a = 57;\n");
    await s.finish(run.id);
    await service().finalizeRun(run.id);
    const row = (await s.row(run.id))!;
    expect(row.status).toBe("captured");
    expect(row.files.map((file) => file.path)).toEqual(["wt57/app.ts"]);
    expect((await service().getFilePatch(s.companyId, run.id, "wt57/app.ts", s.issueId))?.patch).toContain("+export const a = 57;");
  });

  it("notes repositories created during the run instead of listing their checkout", async () => {
    const s = await seed();
    const workspace = mkdtempSync(path.join(tmpdir(), "run-changes-clone-"));
    dirs.push(workspace);
    execFileSync("git", ["clone", "-q", gitRepo(), path.join(workspace, "repo")]);
    const run = await s.newRun();
    await s.start(run, { cwd: workspace });
    execFileSync("git", ["clone", "-q", gitRepo(), path.join(workspace, "wt61")]);
    await s.finish(run.id);
    await service().finalizeRun(run.id);
    const [entry] = await service().listForIssue(s.companyId, s.issueId);
    expect(entry).toMatchObject({ status: "no_changes", newRepos: ["wt61"], files: [] });
  });

  it("listForIssue returns newest first with agent names and totals and only that issue's runs", async () => {
    const s = await seed();
    const older = await s.newRun();
    await s.start(older);
    writeFileSync(path.join(s.cwd, "x.ts"), "x\n");
    await s.finish(older.id);
    await service().finalizeRun(older.id);
    const newer = await s.newRun();
    await s.start(newer);
    await s.finish(newer.id);
    await service().finalizeRun(newer.id);
    const otherIssue = await s.newRun(null);
    await s.start(otherIssue, { issueId: null });
    const list = await service().listForIssue(s.companyId, s.issueId);
    expect(list.map((entry) => entry.runId)).toEqual([newer.id, older.id]);
    expect(list[1]).toMatchObject({ agentName: "FE", status: "captured", additions: 1, deletions: 0, runStatus: "succeeded" });
    expect(list[1]!.files[0]!.path).toBe("x.ts");
  });

  it("getFilePatch is company and issue scoped and finds unicode paths", async () => {
    const s = await seed();
    const run = await s.newRun();
    await s.start(run);
    mkdirSync(path.join(s.cwd, "docs"));
    writeFileSync(path.join(s.cwd, "docs", "Báo cáo.md"), "# Tiêu đề\n");
    await s.finish(run.id);
    await service().finalizeRun(run.id);
    expect((await service().getFilePatch(s.companyId, run.id, "docs/Báo cáo.md", s.issueId))?.patch).toContain("+# Tiêu đề");
    expect(await service().getFilePatch(randomUUID(), run.id, "docs/Báo cáo.md", s.issueId)).toBeNull();
    expect(await service().getFilePatch(s.companyId, run.id, "docs/Báo cáo.md", randomUUID())).toBeNull();
    expect(await service().getFilePatch(s.companyId, run.id, "missing.md", s.issueId)).toBeNull();
  });
});
