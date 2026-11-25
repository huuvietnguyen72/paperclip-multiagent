import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activityLog, companies, companyMemberships, createDb, issues } from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { teamFeedRoutes } from "../routes/team-feed.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

describePostgres("team feed routes", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const userId = randomUUID();
  const companyId = randomUUID();
  const otherCompanyId = randomUUID();
  const issueId = randomUUID();

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-team-feed-routes-");
    db = createDb(database.connectionString);
    await db.insert(companies).values([
      { id: companyId, name: "Feed", issuePrefix: "TFR" },
      { id: otherCompanyId, name: "Other", issuePrefix: "TFO" },
    ]);
    await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user", status: "active", membershipRole: "owner" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Build", identifier: "TFR-1", issueNumber: 1 });
    await db.insert(activityLog).values(["todo", "in_progress", "done"].map((status, index) => ({
      companyId, actorType: "user", actorId: userId, action: "issue.updated", entityType: "issue", entityId: issueId,
      details: { status }, createdAt: new Date(Date.UTC(2026, 10, 25, 9, index)),
    })));
  }, 90_000);
  afterAll(async () => { await database?.cleanup(); });

  const appFor = (companyIds: string[]) => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", source: "session", userId, companyIds, isInstanceAdmin: false } as never;
      next();
    });
    app.use("/api", teamFeedRoutes(db));
    app.use(errorHandler);
    return app;
  };

  it("returns the company's feed", async () => {
    const res = await request(appFor([companyId])).get(`/api/companies/${companyId}/team-feed`).expect(200);
    expect(res.body.items.map((item: { toStatus: string }) => item.toStatus)).toEqual(["done", "in_progress", "todo"]);
    expect(res.body.nextCursor).toBeNull();
  });

  it("refuses a company the user cannot access", async () => {
    await request(appFor([companyId])).get(`/api/companies/${otherCompanyId}/team-feed`).expect(403);
  });

  it("rejects a malformed cursor", async () => {
    await request(appFor([companyId])).get(`/api/companies/${companyId}/team-feed`).query({ before: "bad" }).expect(400);
  });

  it("clamps the page size", async () => {
    const big = await request(appFor([companyId])).get(`/api/companies/${companyId}/team-feed`).query({ limit: "500" }).expect(200);
    expect(big.body.items).toHaveLength(3);
    const one = await request(appFor([companyId])).get(`/api/companies/${companyId}/team-feed`).query({ limit: "1" }).expect(200);
    expect(one.body.items).toHaveLength(1);
    expect(one.body.nextCursor).toBeTruthy();
    const junk = await request(appFor([companyId])).get(`/api/companies/${companyId}/team-feed`).query({ limit: "abc" }).expect(200);
    expect(junk.body.items).toHaveLength(3);
  });
});
