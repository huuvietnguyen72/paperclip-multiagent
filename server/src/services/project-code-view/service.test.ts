import { randomUUID } from "node:crypto";
import {
  activityLog, companies, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, projects, projectWorkspaces, type Db,
} from "@paperclipai/db";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { resolveExternalTestDatabaseUrl } from "../../__tests__/helpers/external-test-database.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import type { CloneHead, CloneRefresh } from "./git.js";
import { createProjectCodeViewService } from "./service.js";

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_CODE_VIEW_TEST_DATABASE_URL");
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skipping project code view database tests: ${support.reason}`);

const HEAD: CloneHead = { branch: "main", head: "87d6557", subject: "fix(web): a11y" };

function fakeGit(refresh: (cwd: string) => Promise<CloneRefresh>) {
  return {
    readCloneHead: vi.fn(async () => HEAD),
    refreshClone: vi.fn(refresh),
  };
}

describePostgres("project code view service", () => {
  let db: Db;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;

  beforeAll(async () => {
    if (!external) database = await startEmbeddedPostgresTestDatabase("paperclip-code-view-");
    db = createDb(external ?? database!.connectionString, { maxConnections: 6 });
    if (external) {
      db.$client.options.onnotice = () => {};
      await db.execute(sql`truncate companies cascade`);
    }
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await database?.cleanup(); });

  async function seed(metadata: Record<string, unknown> = { codeView: { enabled: true }, keep: "me" }) {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const otherProjectId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Code view", issuePrefix: `C${companyId.slice(0, 4).toUpperCase()}` });
    await db.insert(projects).values([
      { id: projectId, companyId, name: "Web" },
      { id: otherProjectId, companyId, name: "Other" },
    ]);
    const [flagged] = await db.insert(projectWorkspaces).values({
      companyId, projectId, name: "Codebase (local main)", sourceType: "local_path", cwd: "/tmp/clone", metadata,
    }).returning();
    await db.insert(projectWorkspaces).values([
      { companyId, projectId, name: "GitHub", sourceType: "git_repo", repoUrl: "https://example.invalid/r.git" },
      { companyId, projectId: otherProjectId, name: "Elsewhere", sourceType: "local_path", cwd: "/tmp/x", metadata: { codeView: { enabled: true } } },
    ]);
    const metadataOf = async () => (await db.select().from(projectWorkspaces).where(eq(projectWorkspaces.id, flagged!.id)))[0]!.metadata as Record<string, any>;
    const activities = async () => db.select().from(activityLog).where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, "project.code_view_refreshed")));
    return { companyId, projectId, workspaceId: flagged!.id, metadataOf, activities };
  }

  const updated = async (): Promise<CloneRefresh> => ({ result: "updated", before: "a".repeat(40), after: "b".repeat(40), error: null });
  const unchanged = async (): Promise<CloneRefresh> => ({ result: "up_to_date", before: "a".repeat(40), after: "a".repeat(40), error: null });

  it("lists only the project's flagged workspaces", async () => {
    const s = await seed();
    const service = createProjectCodeViewService(db, { git: fakeGit(unchanged) });
    const statuses = await service.listStatuses(s.companyId, s.projectId);
    expect(statuses).toHaveLength(1);
    expect(statuses[0]).toMatchObject({
      projectId: s.projectId, workspaceId: s.workspaceId, workspaceName: "Codebase (local main)",
      branch: "main", head: "87d6557", subject: "fix(web): a11y", refreshing: false,
    });
  });

  it("records the refresh outcome and keeps other metadata", async () => {
    const s = await seed();
    const service = createProjectCodeViewService(db, { git: fakeGit(updated) });
    const status = await service.refresh({ companyId: s.companyId, projectId: s.projectId, workspaceId: s.workspaceId, reason: "manual" });
    expect(status.lastResult).toBe("updated");
    const metadata = await s.metadataOf();
    expect(metadata.keep).toBe("me");
    expect(metadata.codeView).toMatchObject({ enabled: true, lastResult: "updated", head: "bbbbbbb", lastError: null });
    expect(typeof metadata.codeView.lastUpdatedAt).toBe("string");
  });

  it("throttles open refreshes for a minute", async () => {
    const s = await seed();
    let now = new Date("2026-11-24T10:00:00.000Z");
    const git = fakeGit(unchanged);
    const service = createProjectCodeViewService(db, { git, now: () => now });
    const input = { companyId: s.companyId, projectId: s.projectId, workspaceId: s.workspaceId, reason: "open" as const };
    await service.refresh(input);
    now = new Date("2026-11-24T10:00:30.000Z");
    await service.refresh(input);
    expect(git.refreshClone).toHaveBeenCalledTimes(1);
    now = new Date("2026-11-24T10:01:01.000Z");
    await service.refresh(input);
    expect(git.refreshClone).toHaveBeenCalledTimes(2);
  });

  it("runs one git refresh at a time per workspace", async () => {
    const s = await seed();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const git = fakeGit(async () => { await gate; return unchanged(); });
    const service = createProjectCodeViewService(db, { git });
    const input = { companyId: s.companyId, projectId: s.projectId, workspaceId: s.workspaceId, reason: "manual" as const };
    const both = Promise.all([service.refresh(input), service.refresh(input)]);
    await vi.waitFor(() => expect(git.refreshClone).toHaveBeenCalledTimes(1));
    release();
    await both;
    expect(git.refreshClone).toHaveBeenCalledTimes(1);
  });

  it("logs manual refreshes always and automatic ones only when the code moved", async () => {
    const s = await seed();
    const base = { companyId: s.companyId, projectId: s.projectId, workspaceId: s.workspaceId };
    await createProjectCodeViewService(db, { git: fakeGit(unchanged) }).refresh({ ...base, reason: "manual" });
    expect(await s.activities()).toHaveLength(1);
    await createProjectCodeViewService(db, { git: fakeGit(unchanged) }).refresh({ ...base, reason: "task_done" });
    expect(await s.activities()).toHaveLength(1);
    await createProjectCodeViewService(db, { git: fakeGit(updated) }).refresh({ ...base, reason: "task_done" });
    const rows = await s.activities();
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.entityType === "project" && row.entityId === s.projectId)).toBe(true);
  });

  it("rejects a workspace without the code view flag", async () => {
    const s = await seed({ keep: "me" });
    const service = createProjectCodeViewService(db, { git: fakeGit(unchanged) });
    await expect(service.refresh({ companyId: s.companyId, projectId: s.projectId, workspaceId: s.workspaceId, reason: "manual" }))
      .rejects.toMatchObject({ status: 404 });
  });

  it("stores a redacted error when git fails", async () => {
    const s = await seed();
    const secret = "ghp_" + "a".repeat(36);
    const git = fakeGit(async () => ({ result: "error", before: null, after: null, error: `fatal: auth failed for ${secret}` }));
    const service = createProjectCodeViewService(db, { git });
    const status = await service.refresh({ companyId: s.companyId, projectId: s.projectId, workspaceId: s.workspaceId, reason: "manual" });
    expect(status.lastResult).toBe("error");
    expect(status.lastError).toContain("fatal: auth failed");
    expect(status.lastError).not.toContain(secret);
  });

  it("refreshes every flagged workspace of a project", async () => {
    const s = await seed();
    const git = fakeGit(unchanged);
    const service = createProjectCodeViewService(db, { git });
    await service.refreshProject(s.companyId, s.projectId, "task_done");
    expect(git.refreshClone).toHaveBeenCalledTimes(1);
    expect(git.refreshClone).toHaveBeenCalledWith("/tmp/clone");
  });
});
