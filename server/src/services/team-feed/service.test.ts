import { randomUUID } from "node:crypto";
import {
  activityLog, agents, companies, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, heartbeatRunChanges, heartbeatRuns,
  issueComments, issues, type Db,
} from "@paperclipai/db";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveExternalTestDatabaseUrl } from "../../__tests__/helpers/external-test-database.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { createTeamFeedService, parseTeamFeedCursor } from "./service.js";

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_TEAM_FEED_TEST_DATABASE_URL");
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skipping team feed database tests: ${support.reason}`);

const t = (minutes: number) => new Date(Date.UTC(2026, 10, 25, 9, 0) + minutes * 60_000);
const everything = sql<boolean>`true`;

describePostgres("team feed service", () => {
  let db: Db;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  const companyId = randomUUID();
  const otherCompanyId = randomUUID();
  const issueId = randomUUID();
  const privateIssueId = randomUUID();
  const otherIssueId = randomUUID();
  let fe = "";
  const ids = { inProgress: randomUUID(), blocked: randomUUID(), inReview: randomUUID(), done: randomUUID(), privateRow: randomUUID() };

  beforeAll(async () => {
    if (!external) database = await startEmbeddedPostgresTestDatabase("paperclip-team-feed-");
    db = createDb(external ?? database!.connectionString, { maxConnections: 6 });
    if (external) await db.execute(sql`truncate companies cascade`);
    await db.insert(companies).values([
      { id: companyId, name: "Feed", issuePrefix: "QUA" },
      { id: otherCompanyId, name: "Other", issuePrefix: "OTH" },
    ]);
    const [feAgent] = await db.insert(agents).values({ companyId, name: "FE", adapterType: "claude_local", adapterConfig: {} }).returning();
    const [otherAgent] = await db.insert(agents).values({ companyId: otherCompanyId, name: "X", adapterType: "claude_local", adapterConfig: {} }).returning();
    fe = feAgent!.id;
    await db.insert(issues).values([
      { id: issueId, companyId, title: "Màn hình đối soát", identifier: "QUA-1", issueNumber: 1 },
      { id: privateIssueId, companyId, title: "Secret", identifier: "QUA-2", issueNumber: 2 },
      { id: otherIssueId, companyId: otherCompanyId, title: "Elsewhere", identifier: "OTH-1", issueNumber: 1 },
    ]);
    const status = (id: string, at: Date, actorType: string, agentId: string | null, details: Record<string, unknown>, entityId = issueId, company = companyId) => ({
      id, companyId: company, actorType, actorId: agentId ?? actorType, action: "issue.updated", entityType: "issue",
      entityId, agentId, details, createdAt: at,
    });
    await db.insert(activityLog).values([
      status(ids.inProgress, t(0), "agent", fe, { status: "in_progress", changes: { status: { from: "todo", to: "in_progress" } } }),
      status(ids.blocked, t(5), "system", null, { status: "blocked", previousStatus: "todo", source: "recovery.reconcile_configuration_incomplete" }),
      status(ids.inReview, t(10), "agent", fe, { status: "in_review", source: "comment", changes: { status: { from: "in_progress", to: "in_review" } } }),
      status(ids.done, t(20), "user", null, { status: "done", _previous: { status: "in_review" } }),
      status(randomUUID(), t(21), "agent", fe, { title: "renamed" }),
      status(randomUUID(), t(22), "agent", fe, { status: "done", changes: { status: { from: "done", to: "done" } } }),
      status(ids.privateRow, t(15), "agent", fe, { status: "in_progress" }, privateIssueId),
      status(randomUUID(), t(16), "agent", otherAgent!.id, { status: "done" }, otherIssueId, otherCompanyId),
    ]);
    await db.insert(issueComments).values([
      { companyId, issueId, authorAgentId: fe, body: "**Xong** phần API", createdAt: t(9) },
      { companyId, issueId, authorAgentId: fe, body: "Đã sửa theo review", createdAt: t(19.5) },
      { companyId, issueId, authorAgentId: fe, body: "deleted note", createdAt: t(19.8), deletedAt: t(19.9) },
    ]);
    const runRow = async (startedAt: Date, finishedAt: Date | null, status: string, files: Array<{ path: string; additions: number; deletions: number }>) => {
      const [hr] = await db.insert(heartbeatRuns).values({
        companyId, agentId: fe, issueId, invocationSource: "on_demand", status: finishedAt ? "succeeded" : "running",
        runtimeMode: "legacy", startedAt, finishedAt,
      }).returning();
      await db.insert(heartbeatRunChanges).values({
        companyId, runId: hr!.id, issueId, agentId: fe, cwd: "/w", status, startedAt,
        additions: files.reduce((s, f) => s + f.additions, 0), deletions: files.reduce((s, f) => s + f.deletions, 0),
        files: files.map((f) => ({ ...f, oldPath: null, status: "modified", binary: false, truncated: false, collapsedByDefault: false })),
      });
    };
    await runRow(t(-1), t(12), "captured", [{ path: "apps/api/a.ts", additions: 10, deletions: 2 }]);
    await runRow(t(19), null, "pending", []);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await database?.cleanup(); });

  const service = () => createTeamFeedService(db);
  const byId = async () => new Map((await service().list({ companyId, readCondition: everything })).items.map((item) => [item.id, item]));

  it("lists real status changes newest first", async () => {
    const { items } = await service().list({ companyId, readCondition: everything });
    expect(items.map((item) => item.id)).toEqual([ids.done, ids.privateRow, ids.inReview, ids.blocked, ids.inProgress]);
    expect(items[0]).toMatchObject({ fromStatus: "in_review", toStatus: "done", issue: { id: issueId, identifier: "QUA-1", title: "Màn hình đối soát" } });
  });

  it("names the actor and keeps meaningful reasons", async () => {
    const items = await byId();
    expect(items.get(ids.inReview)?.actor).toEqual({ kind: "agent", agentId: fe, name: "FE" });
    expect(items.get(ids.done)?.actor.name).toBe("Board");
    expect(items.get(ids.blocked)).toMatchObject({
      actor: { kind: "system", name: "System" }, fromStatus: "todo", reason: "recovery.reconcile_configuration_incomplete",
    });
    expect(items.get(ids.inReview)?.reason).toBeNull();
  });

  it("shows the whole task on done and this step's runs otherwise", async () => {
    const items = await byId();
    expect(items.get(ids.done)?.changes).toMatchObject({
      pending: true, totalFiles: 1, additions: 10, deletions: 2, files: [{ path: "apps/api/a.ts", additions: 10, deletions: 2 }],
    });
    expect(items.get(ids.inReview)?.changes).toMatchObject({ pending: false, totalFiles: 1 });
    expect(items.get(ids.inProgress)?.changes).toBeNull();
  });

  it("attaches the agent's latest live note from this step", async () => {
    const items = await byId();
    expect(items.get(ids.inReview)?.note).toBe("Xong phần API");
    expect(items.get(ids.done)?.note).toBe("Đã sửa theo review");
    expect(items.get(ids.inProgress)?.note).toBeNull();
  });

  it("hides tasks the reader cannot open and still fills the page", async () => {
    const { items } = await service().list({ companyId, readCondition: sql<boolean>`${issues.id} <> ${privateIssueId}`, limit: 2 });
    expect(items.map((item) => item.id)).toEqual([ids.done, ids.inReview]);
  });

  it("pages with a cursor without gaps or duplicates", async () => {
    const first = await service().list({ companyId, readCondition: everything, limit: 2 });
    expect(first.nextCursor).toBeTruthy();
    const second = await service().list({ companyId, readCondition: everything, limit: 2, before: first.nextCursor });
    const third = await service().list({ companyId, readCondition: everything, limit: 2, before: second.nextCursor });
    const all = [...first.items, ...second.items, ...third.items].map((item) => item.id);
    expect(all).toEqual([ids.done, ids.privateRow, ids.inReview, ids.blocked, ids.inProgress]);
    expect(third.nextCursor).toBeNull();
  });

  it("orders rows with the same time by id across pages", async () => {
    const sameAt = t(30);
    const a = "00000000-0000-4000-8000-00000000000a";
    const b = "00000000-0000-4000-8000-00000000000b";
    await db.insert(activityLog).values([a, b].map((id) => ({
      id, companyId, actorType: "agent", actorId: fe, action: "issue.updated", entityType: "issue", entityId: issueId,
      agentId: fe, details: { status: "blocked", previousStatus: "done" }, createdAt: sameAt,
    })));
    const first = await service().list({ companyId, readCondition: everything, limit: 1 });
    const second = await service().list({ companyId, readCondition: everything, limit: 1, before: first.nextCursor });
    expect([first.items[0]?.id, second.items[0]?.id]).toEqual([b, a]);
    await db.execute(sql`delete from activity_log where id in (${a}, ${b})`);
  });

  it("never returns another company's rows", async () => {
    const { items } = await service().list({ companyId: otherCompanyId, readCondition: everything });
    expect(items.map((item) => item.issue.identifier)).toEqual(["OTH-1"]);
  });

  it("rejects a malformed cursor", () => {
    expect(() => parseTeamFeedCursor("bad")).toThrow(expect.objectContaining({ status: 400 }));
    expect(parseTeamFeedCursor(null)).toBeNull();
  });
});
