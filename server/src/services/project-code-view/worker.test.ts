import { randomUUID } from "node:crypto";
import {
  companies, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, issues, projects, type Db,
} from "@paperclipai/db";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { resolveExternalTestDatabaseUrl } from "../../__tests__/helpers/external-test-database.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { publishLiveEvent } from "../live-events.js";
import { registerProjectCodeViewRefresh } from "./worker.js";

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_CODE_VIEW_TEST_DATABASE_URL");
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

describePostgres("project code view refresh worker", () => {
  let db: Db;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  const companyId = randomUUID();
  const projectId = randomUUID();
  const issueId = randomUUID();
  const looseIssueId = randomUUID();

  beforeAll(async () => {
    if (!external) database = await startEmbeddedPostgresTestDatabase("paperclip-code-view-worker-");
    db = createDb(external ?? database!.connectionString, { maxConnections: 4 });
    if (external) await db.execute(sql`truncate companies cascade`);
    await db.insert(companies).values({ id: companyId, name: "Worker", issuePrefix: "CVW" });
    await db.insert(projects).values({ id: projectId, companyId, name: "Web" });
    await db.insert(issues).values([
      { id: issueId, companyId, projectId, title: "Build it", identifier: "CVW-1", issueNumber: 1 },
      { id: looseIssueId, companyId, title: "No project", identifier: "CVW-2", issueNumber: 2 },
    ]);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await database?.cleanup(); });

  const activity = (payload: Record<string, unknown>) =>
    publishLiveEvent({ companyId, type: "activity.logged", payload: { action: "issue.updated", entityType: "issue", entityId: issueId, ...payload } });

  it("refreshes the issue's project when the issue becomes done", async () => {
    const refreshProject = vi.fn(async () => {});
    const worker = registerProjectCodeViewRefresh({ refreshProject }, db);
    try {
      activity({ details: { status: "done" } });
      await vi.waitFor(() => expect(refreshProject).toHaveBeenCalledWith(companyId, projectId, "task_done"));
    } finally { worker.stop(); }
  });

  it("ignores other statuses, other entities and issues without a project", async () => {
    const refreshProject = vi.fn(async () => {});
    const worker = registerProjectCodeViewRefresh({ refreshProject }, db);
    try {
      activity({ details: { status: "in_progress" } });
      activity({ entityType: "agent", details: { status: "done" } });
      activity({ entityId: looseIssueId, details: { status: "done" } });
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(refreshProject).not.toHaveBeenCalled();
    } finally { worker.stop(); }
  });

  it("swallows a failing refresh", async () => {
    const refreshProject = vi.fn(async () => { throw new Error("git exploded"); });
    const worker = registerProjectCodeViewRefresh({ refreshProject }, db);
    try {
      activity({ details: { status: "done" } });
      await vi.waitFor(() => expect(refreshProject).toHaveBeenCalled());
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally { worker.stop(); }
  });
});
