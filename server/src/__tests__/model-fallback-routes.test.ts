import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { agents, agentConfigRevisions, agentModelFallbackStates, companies, companyMemberships, createDb } from "@paperclipai/db";
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

  const appFor = (actor: Express.Request["actor"]) => {
    const scoped = express(); scoped.use(express.json());
    scoped.use((req, _res, next) => { req.actor = actor; next(); });
    scoped.use("/api", agentRoutes(db));
    scoped.use("/api", modelFallbackRoutes(db));
    scoped.use((error: { status?: number; message: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(error.status ?? 500).json({ error: error.message });
    });
    return scoped;
  };
  const enabledChain = (connectionId: string) => ({ enabled: true, connections: [{ id: connectionId, adapterType: "codex_local", adapterConfig: { model: "gpt-5" } }] });

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

  it("PATCH switching to paperclip_runner with a stored enabled chain returns 422", async () => {
    await db.update(agents).set({ runtimeConfig: { modelFallback: enabledChain(randomUUID()) } }).where(eq(agents.id, agent.id));
    const response = await request(app).patch(`/api/agents/${agent.id}`).send({ adapterType: "paperclip_runner" });
    expect(response.status, JSON.stringify(response.body)).toBe(422);
    expect(response.body.error).toMatch(/Paperclip runner/);
    expect(await revisions()).toHaveLength(0);
    expect((await db.select().from(agents).where(eq(agents.id, agent.id)))[0]!.adapterType).toBe("claude_local");
  });

  it("PATCH default swap moving the old default into the chain returns 200 with one revision", async () => {
    const connectionId = randomUUID();
    await db.update(agents).set({ runtimeConfig: { modelFallback: enabledChain(connectionId) } }).where(eq(agents.id, agent.id));
    const response = await request(app).patch(`/api/agents/${agent.id}`).send({
      adapterType: "codex_local",
      adapterConfig: { model: "gpt-5" },
      runtimeConfig: { modelFallback: { enabled: true, connections: [
        { id: randomUUID(), adapterType: "claude_local", adapterConfig: { model: "claude-sonnet-4-5" } },
      ] } },
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(await revisions()).toHaveLength(1);
    const saved = (await db.select().from(agents).where(eq(agents.id, agent.id)))[0]!;
    expect(saved.adapterType).toBe("codex_local");
    expect((saved.runtimeConfig as { modelFallback: { connections: unknown[] } }).modelFallback.connections).toHaveLength(1);
  });

  it("GET view follows the GET /agents/:id rules for agent actors", async () => {
    const sameCompany = appFor({ type: "agent", agentId: agent.id, companyId, runId: null, source: "agent_key" } as never);
    const baseline = await request(sameCompany).get(`/api/agents/${agent.id}`);
    const view = await request(sameCompany).get(`/api/agents/${agent.id}/model-fallback`);
    expect(baseline.status).toBe(200);
    expect(view.status, JSON.stringify(view.body)).toBe(baseline.status);
    expect(view.body.connections[0].id).toBe("default");
    const foreign = appFor({ type: "agent", agentId: foreignAgent.id, companyId: foreignAgent.companyId, runId: null, source: "agent_key" } as never);
    expect((await request(foreign).get(`/api/agents/${agent.id}`)).status).toBe(404);
    expect((await request(foreign).get(`/api/agents/${agent.id}/model-fallback`)).status).toBe(404);
  });

  it("GET active returns switched agents of the company and excludes other companies", async () => {
    const connectionId = randomUUID();
    await db.update(agents).set({ runtimeConfig: { modelFallback: enabledChain(connectionId) } }).where(eq(agents.id, agent.id));
    await db.update(agents).set({ runtimeConfig: { modelFallback: enabledChain(connectionId) } }).where(eq(agents.id, foreignAgent.id));
    await db.insert(agentModelFallbackStates).values([
      { companyId, agentId: agent.id, activeConnectionId: connectionId },
      { companyId: foreignAgent.companyId, agentId: foreignAgent.id, activeConnectionId: connectionId },
    ]);
    const response = await request(app).get(`/api/companies/${companyId}/model-fallback/active`);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body).toEqual([expect.objectContaining({ agentId: agent.id, connectionId, adapterType: "codex_local", model: "gpt-5", isFallback: true })]);
  });
});
