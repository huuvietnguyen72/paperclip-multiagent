import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { agents, agentConfigRevisions, companies, companyMemberships, createDb } from "@paperclipai/db";
import { agentRoutes } from "../routes/agents.js";
import { modelFallbackRoutes } from "../routes/model-fallback.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

describePostgres("model fallback routes", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let home: string;
  let app: express.Express;
  let agent: typeof agents.$inferSelect;
  let foreignAgent: typeof agents.$inferSelect;
  let companyId: string;
  let fixtureNumber = 0;
  const userId = randomUUID();

  beforeAll(async () => {
    home = await realpath(await mkdtemp(path.join(os.tmpdir(), "paperclip-model-fallback-")));
    vi.stubEnv("PAPERCLIP_HOME", home);
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "model-fallback-routes");
    database = await startEmbeddedPostgresTestDatabase("paperclip-model-fallback-routes-");
    db = createDb(database.connectionString);
  }, 90_000);

  beforeEach(async () => {
    companyId = randomUUID();
    const otherCompanyId = randomUUID();
    await db.insert(companies).values([
      { id: companyId, name: "Fallback", issuePrefix: `MF${++fixtureNumber}A` },
      { id: otherCompanyId, name: "Other", issuePrefix: `MF${fixtureNumber}B` },
    ]);
    await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user", status: "active", membershipRole: "owner" });
    [agent] = await db.insert(agents).values({ companyId, name: "Fallback agent", adapterType: "claude_local", adapterConfig: { model: "claude-sonnet-4-5" } }).returning();
    [foreignAgent] = await db.insert(agents).values({ companyId: otherCompanyId, name: "Foreign agent", adapterType: "claude_local", adapterConfig: { model: "claude-sonnet-4-5" } }).returning();
    app = express(); app.use(express.json());
    app.use((req, _res, next) => { req.actor = { type: "board", source: "session", isInstanceAdmin: true, userId, companyIds: [companyId] }; next(); });
    app.use("/api", agentRoutes(db));
    app.use("/api", modelFallbackRoutes(db));
    app.use((error: { status?: number; message: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(error.status ?? 500).json({ error: error.message });
    });
  });
  afterAll(async () => {
    await database?.cleanup(); vi.unstubAllEnvs();
    if (home) await rm(home, { recursive: true, force: true });
  });

  const revisions = async () => db.select().from(agentConfigRevisions).where(eq(agentConfigRevisions.agentId, agent.id));

  it("GET view returns 404 for an agent in another company", async () => {
    const response = await request(app).get(`/api/agents/${foreignAgent.id}/model-fallback`);
    expect(response.status).toBe(404);
  });

  it("GET view returns default-only chain for an agent without config", async () => {
    const response = await request(app).get(`/api/agents/${agent.id}/model-fallback`);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.enabled).toBe(false);
    expect(response.body.connections).toHaveLength(1);
    expect(response.body.connections[0].id).toBe("default");
  });

  it("GET active lists nothing for a company without switched agents and rejects other companies", async () => {
    const ok = await request(app).get(`/api/companies/${companyId}/model-fallback/active`);
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual([]);
    const denied = await request(app).get(`/api/companies/${foreignAgent.companyId}/model-fallback/active`);
    expect(denied.status).toBe(403);
  });

  it("PATCH rejects an incompatible binding", async () => {
    const response = await request(app).patch(`/api/agents/${agent.id}`).send({ runtimeConfig: { modelFallback: {
      enabled: true,
      connections: [{ id: randomUUID(), adapterType: "opencode_local", adapterConfig: { model: "opencode/some-model" },
        aiConnection: { provider: "anthropic", method: "api_key", mode: "responsible_user" } }],
    } } });
    expect(response.status, JSON.stringify(response.body)).toBe(422);
    expect(response.body.error).toMatch(/not compatible/);
    expect(await revisions()).toHaveLength(0);
  });

  it("PATCH accepts a valid chain and writes one config revision", async () => {
    const connectionId = randomUUID();
    const response = await request(app).patch(`/api/agents/${agent.id}`).send({ runtimeConfig: { modelFallback: {
      enabled: true,
      connections: [{ id: connectionId, adapterType: "codex_local", adapterConfig: { model: "gpt-5" } }],
    } } });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(await revisions()).toHaveLength(1);
    const view = await request(app).get(`/api/agents/${agent.id}/model-fallback`);
    expect(view.body.enabled).toBe(true);
    expect(view.body.connections.map((c: { id: string }) => c.id)).toEqual(["default", connectionId]);
  });
});
