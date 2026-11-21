import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents, companies, companyMemberships, createDb, heartbeatRunChangeFiles, heartbeatRunChanges, heartbeatRuns, issues,
} from "@paperclipai/db";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

describePostgres("run changes routes", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let home: string;
  const userId = randomUUID();
  const companyId = randomUUID();
  const otherCompanyId = randomUUID();
  const issueId = randomUUID();
  const otherIssueId = randomUUID();
  const runId = randomUUID();
  const otherIssueRunId = randomUUID();
  const unicodePath = "docs/Báo cáo cuối kỳ.md";

  beforeAll(async () => {
    home = await realpath(await mkdtemp(path.join(os.tmpdir(), "paperclip-run-changes-routes-")));
    vi.stubEnv("PAPERCLIP_HOME", home);
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "run-changes-routes");
    database = await startEmbeddedPostgresTestDatabase("paperclip-run-changes-routes-");
    db = createDb(database.connectionString);
    await db.insert(companies).values([
      { id: companyId, name: "Run changes", issuePrefix: "RCA" },
      { id: otherCompanyId, name: "Other", issuePrefix: "RCB" },
    ]);
    await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user", status: "active", membershipRole: "owner" });
    const [agent] = await db.insert(agents).values({ companyId, name: "FE", adapterType: "claude_local", adapterConfig: {} }).returning();
    await db.insert(issues).values([
      { id: issueId, companyId, title: "Calendar", status: "in_progress", identifier: "RCA-1", assigneeAgentId: agent!.id },
      { id: otherIssueId, companyId, title: "Other", status: "in_progress", identifier: "RCA-2", assigneeAgentId: agent!.id },
    ]);
    for (const [id, forIssue] of [[runId, issueId], [otherIssueRunId, otherIssueId]] as const) {
      await db.insert(heartbeatRuns).values({ id, companyId, agentId: agent!.id, issueId: forIssue, invocationSource: "on_demand",
        status: "succeeded", runtimeMode: "legacy", startedAt: new Date(), finishedAt: new Date() });
      const [change] = await db.insert(heartbeatRunChanges).values({
        companyId, runId: id, issueId: forIssue, agentId: agent!.id, cwd: "/w", status: "captured", additions: 1, deletions: 0,
        files: [{ path: unicodePath, oldPath: null, status: "added", additions: 1, deletions: 0, binary: false, truncated: false, collapsedByDefault: false }],
        commands: [{ ts: null, tool: "Terminal", text: "echo hi" }],
      }).returning();
      await db.insert(heartbeatRunChangeFiles).values({ runChangeId: change!.id, path: unicodePath, patch: "@@ -0,0 +1 @@\n+# Tiêu đề\n" });
    }
  }, 90_000);

  afterAll(async () => {
    await database?.cleanup(); vi.unstubAllEnvs();
    if (home) await rm(home, { recursive: true, force: true });
  });

  const appFor = (companyIds: string[]) => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", source: "session", userId, companyIds, isInstanceAdmin: false } as never;
      next();
    });
    app.use("/api", issueRoutes(db, { wakeup: async () => null } as never));
    app.use(errorHandler);
    return app;
  };

  it("lists the issue's run changes", async () => {
    const res = await request(appFor([companyId])).get(`/api/issues/${issueId}/run-changes`);
    expect(res.status).toBe(200);
    expect(res.body.map((entry: { runId: string }) => entry.runId)).toEqual([runId]);
    expect(res.body[0]).toMatchObject({ agentName: "FE", status: "captured", additions: 1, commands: [{ text: "echo hi" }] });
  });

  it("hides another company's issue", async () => {
    const res = await request(appFor([otherCompanyId])).get(`/api/issues/${issueId}/run-changes`);
    expect(res.status).toBe(404);
  });

  it("returns one file patch for a unicode path", async () => {
    const res = await request(appFor([companyId]))
      .get(`/api/issues/${issueId}/run-changes/${runId}/file`).query({ path: unicodePath });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ runId, path: unicodePath, binary: false, truncated: false });
    expect(res.body.patch).toContain("+# Tiêu đề");
  });

  it("404s for an unknown run, a path not in the run, and a run of another issue", async () => {
    const app = appFor([companyId]);
    expect((await request(app).get(`/api/issues/${issueId}/run-changes/${randomUUID()}/file`).query({ path: unicodePath })).status).toBe(404);
    expect((await request(app).get(`/api/issues/${issueId}/run-changes/${runId}/file`).query({ path: "missing.md" })).status).toBe(404);
    expect((await request(app).get(`/api/issues/${issueId}/run-changes/${otherIssueRunId}/file`).query({ path: unicodePath })).status).toBe(404);
    expect((await request(app).get(`/api/issues/${issueId}/run-changes/${runId}/file`)).status).toBe(400);
  });
});
