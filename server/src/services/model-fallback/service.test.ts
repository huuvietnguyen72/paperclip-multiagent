import { randomUUID } from "node:crypto";
import {
  activityLog, agentModelFallbackStates, agents, companies, companyMemberships, createDb,
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, heartbeatRuns, issueComments, issues, modelAccountExhaustions, type Db,
} from "@paperclipai/db";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveExternalTestDatabaseUrl } from "../../__tests__/helpers/external-test-database.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { forbidden } from "../../errors.js";
import { aiConnectionConfigurationFailure } from "../ai-connection-configuration-failure.js";
import { aiConnectionService } from "../ai-connections.js";
import { buildChain } from "./policy.js";
import { createModelFallbackService } from "./service.js";

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_MODEL_FALLBACK_TEST_DATABASE_URL");
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skipping model fallback database tests: ${support.reason}`);

const FALLBACK_MODEL = "opencode-go/glm-5.3";
const DEFAULT_MODEL = "claude-sonnet-5-5";

describePostgres("model fallback service", () => {
  let db: Db;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let clock = new Date();

  beforeAll(async () => {
    if (!external) database = await startEmbeddedPostgresTestDatabase("paperclip-model-fallback-");
    db = createDb(external ?? database!.connectionString, { maxConnections: 6 });
    if (external) {
      db.$client.options.onnotice = () => {};
      await db.execute(sql`truncate companies cascade`);
    }
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await database?.cleanup(); });

  // A shared/delegated binding names its connection; tests skip seeding a real AI connection.
  const resolveAccountConnectionId = async ({ entry }: { entry: { aiConnection: unknown } }) => {
    const binding = entry.aiConnection as { connectionId?: string } | null;
    return binding?.connectionId ?? null;
  };
  const service = () => createModelFallbackService(db, { now: () => clock, resolveAccountConnectionId });

  async function seed(options: { fallback?: boolean } = {}) {
    clock = new Date();
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    const connectionId = randomUUID(), fallbackId = randomUUID();
    const identifier = `F${companyId.slice(0, 6)}-1`;
    await db.insert(companies).values({ id: companyId, name: "Fallback", issuePrefix: `F${companyId.slice(0, 6)}` });
    const runtimeConfig = (withFallback: boolean) => ({
      heartbeat: { enabled: false },
      aiConnection: { provider: "anthropic", method: "subscription", mode: "shared", connectionId, grantId: randomUUID() },
      ...(withFallback ? {
        modelFallback: {
          enabled: true,
          connections: [{ id: fallbackId, adapterType: "opencode_local", adapterConfig: { model: FALLBACK_MODEL } }],
        },
      } : {}),
    });
    const insertAgent = async (id: string, name: string) => db.insert(agents).values({
      id, companyId, name, role: "engineer", status: "idle", adapterType: "claude_local",
      adapterConfig: { model: DEFAULT_MODEL, cwd: "/work" }, runtimeConfig: runtimeConfig(options.fallback !== false),
    });
    await insertAgent(agentId, "Worker");
    await db.insert(issues).values({ id: issueId, companyId, title: "Fix the login form", status: "in_progress",
      assigneeAgentId: agentId, identifier });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, issueId, invocationSource: "on_demand",
      status: "queued", runtimeMode: "legacy" });
    const loadAgent = (id: string = agentId) => db.select().from(agents).where(eq(agents.id, id)).then((rows) => rows[0]!);
    const loadRun = (id: string = runId) => db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id)).then((rows) => rows[0]!);
    const newRun = async (forAgentId = agentId, forIssueId: string | null = issueId) => {
      const id = randomUUID();
      await db.insert(heartbeatRuns).values({ id, companyId, agentId: forAgentId, issueId: forIssueId,
        invocationSource: "on_demand", status: "queued", runtimeMode: "legacy" });
      return loadRun(id);
    };
    const failQuota = async (record: Record<string, unknown> | null) => {
      await db.update(heartbeatRuns).set({
        status: "failed", errorCode: "provider_quota", error: "Claude usage limit reached",
        startedAt: clock, finishedAt: clock,
        resultJson: { message: "You've hit your limit · resets 20:00 (UTC)" },
        runnerProfileJson: record ? { adapterDispatch: { modelFallback: record } } : {},
      }).where(eq(heartbeatRuns.id, runId));
      return loadRun();
    };
    const defaultRecord = {
      connectionId: "default", accountKey: `ai:${connectionId}`, adapterType: "claude_local",
      model: DEFAULT_MODEL, isFallback: false,
    };
    const actions = (action: string) => db.select().from(activityLog)
      .where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, action)));
    const state = (id: string = agentId) => db.select().from(agentModelFallbackStates)
      .where(and(eq(agentModelFallbackStates.companyId, companyId), eq(agentModelFallbackStates.agentId, id)))
      .then((rows) => rows[0] ?? null);
    const exhaustions = () => db.select().from(modelAccountExhaustions)
      .where(eq(modelAccountExhaustions.companyId, companyId));
    const systemComments = () => db.select().from(issueComments)
      .where(and(eq(issueComments.companyId, companyId), eq(issueComments.authorType, "system")));
    return { companyId, agentId, issueId, runId, identifier, connectionId, fallbackId, insertAgent, loadAgent, loadRun, newRun,
      failQuota, defaultRecord, actions, state, exhaustions, systemComments };
  }

  function nextUtc20(now: Date) {
    const expected = new Date(now);
    expected.setUTCHours(20, 0, 0, 0);
    if (expected.getTime() <= now.getTime()) expected.setUTCDate(expected.getUTCDate() + 1);
    return expected;
  }

  /** Records a quota failure on the default and dispatches the next run, which switches. */
  async function switchToFallback(s: Awaited<ReturnType<typeof seed>>) {
    await service().recordQuotaFailure({ run: await s.failQuota(s.defaultRecord), agent: await s.loadAgent() });
    return service().selectForDispatch({ agent: await s.loadAgent(), run: await s.newRun(), responsibleUserId: null });
  }

  it("selectForDispatch returns null record when no chain", async () => {
    const s = await seed({ fallback: false });
    const result = await service().selectForDispatch({ agent: await s.loadAgent(), run: await s.loadRun(), responsibleUserId: null });
    expect(result.adapterType).toBe("claude_local");
    expect(result.record).toBeNull();
    expect(await s.state()).toBeNull();
  });

  it("accountKeyFor returns null when responsible_user has no default", async () => {
    const s = await seed();
    const userId = `user-${randomUUID()}`;
    await db.insert(companyMemberships).values({ companyId: s.companyId, principalType: "user", principalId: userId,
      status: "active" });
    const agent = await s.loadAgent();
    const entry = { ...buildChain(agent)[0]!, aiConnection: { provider: "anthropic", method: "subscription", mode: "responsible_user" } as const };
    // The real resolver path: the responsible user is a member but has no personal default.
    await expect(aiConnectionService(db).select({ companyId: s.companyId, agentId: s.agentId, userId,
      adapterType: entry.adapterType, model: entry.adapterConfig.model, binding: entry.aiConnection }))
      .rejects.toThrow(/personal default/);
    const real = createModelFallbackService(db, { now: () => clock });
    expect(await real.accountKeyFor({ companyId: s.companyId, agentId: s.agentId, responsibleUserId: userId, entry })).toBeNull();
    const opencode = buildChain(agent)[1]!;
    expect(await real.accountKeyFor({ companyId: s.companyId, agentId: s.agentId, responsibleUserId: userId, entry: opencode }))
      .toBe("login:opencode_local");
  });

  it("quota failure records exhaustion for the run's account", async () => {
    const s = await seed();
    const result = await service().recordQuotaFailure({ run: await s.failQuota(s.defaultRecord), agent: await s.loadAgent() });
    expect(result.retryNow).toBe(true);
    const rows = await s.exhaustions();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ accountKey: `ai:${s.connectionId}`, parsedResetTime: true, sourceRunId: s.runId });
    expect(rows[0]!.exhaustedUntil.toISOString()).toBe(nextUtc20(clock).toISOString());
    expect(await s.state()).toBeNull();
  });

  it("quota failure without dispatch record keeps legacy path", async () => {
    const s = await seed();
    const result = await service().recordQuotaFailure({ run: await s.failQuota(null), agent: await s.loadAgent() });
    expect(result.retryNow).toBe(false);
    expect(await s.exhaustions()).toHaveLength(0);
  });

  it("next dispatch switches and pins the issue", async () => {
    const s = await seed();
    const result = await switchToFallback(s);
    expect(result.adapterType).toBe("opencode_local");
    expect(result.kind).toBe("switch");
    expect(result.record).toEqual({ connectionId: s.fallbackId, accountKey: "login:opencode_local",
      adapterType: "opencode_local", model: FALLBACK_MODEL, isFallback: true });
    const state = await s.state();
    expect(state?.activeConnectionId).toBe(s.fallbackId);
    expect(state?.pinnedIssueIds).toContain(s.issueId);
    const switched = await s.actions("agent.model_fallback.switched");
    expect(switched).toHaveLength(1);
    expect(switched[0]!.details).toMatchObject({ from: "default", to: s.fallbackId, reason: "account_exhausted",
      resetAt: nextUtc20(clock).toISOString() });
    const comments = await s.systemComments();
    expect(comments).toHaveLength(1);
    expect(comments[0]!.issueId).toBe(s.issueId);
    expect(comments[0]!.body).toContain("chuyển sang OpenCode Go · opencode-go/glm-5.3");
    expect(comments[0]!.body).toContain(`${DEFAULT_MODEL} hết token (reset `);
  });

  it("other agent on the same account switches before failing", async () => {
    const s = await seed();
    await service().recordQuotaFailure({ run: await s.failQuota(s.defaultRecord), agent: await s.loadAgent() });
    const otherId = randomUUID();
    await s.insertAgent(otherId, "Second worker");
    const result = await service().selectForDispatch({ agent: await s.loadAgent(otherId), run: await s.newRun(otherId, null),
      responsibleUserId: null });
    expect(result.adapterType).toBe("opencode_local");
    expect(result.record?.isFallback).toBe(true);
    expect((await s.state(otherId))?.activeConnectionId).toBe(s.fallbackId);
  });

  it("returns after pinned issue done and reset passed", async () => {
    const s = await seed();
    await switchToFallback(s);
    await db.update(modelAccountExhaustions).set({ exhaustedUntil: new Date(clock.getTime() - 60_000) })
      .where(eq(modelAccountExhaustions.companyId, s.companyId));
    const unfinished = await service().selectForDispatch({ agent: await s.loadAgent(), run: await s.newRun(), responsibleUserId: null });
    expect(unfinished.kind).toBe("stay");
    expect(unfinished.adapterType).toBe("opencode_local");
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, s.issueId));
    const result = await service().selectForDispatch({ agent: await s.loadAgent(), run: await s.newRun(), responsibleUserId: null });
    expect(result.kind).toBe("return");
    expect(result.adapterType).toBe("claude_local");
    expect(result.record).toMatchObject({ connectionId: "default", isFallback: false });
    expect(await s.actions("agent.model_fallback.returned")).toHaveLength(1);
    const state = await s.state();
    expect(state?.activeConnectionId).toBeNull();
    expect(state?.pinnedIssueIds).toEqual([]);
    const comments = await s.systemComments();
    expect(comments.map((comment) => comment.body)).toContain(
      `OpenCode Go · ${FALLBACK_MODEL} → quay về Claude Code · ${DEFAULT_MODEL} (mặc định).`,
    );
  });

  it("blocked issue counts as finished", async () => {
    const s = await seed();
    await switchToFallback(s);
    await db.update(modelAccountExhaustions).set({ exhaustedUntil: new Date(clock.getTime() - 60_000) })
      .where(eq(modelAccountExhaustions.companyId, s.companyId));
    await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, s.issueId));
    const result = await service().selectForDispatch({ agent: await s.loadAgent(), run: await s.newRun(), responsibleUserId: null });
    expect(result.kind).toBe("return");
    expect(result.adapterType).toBe("claude_local");
  });

  it("readAgentView marks in-use and exhausted connections", async () => {
    const s = await seed();
    await switchToFallback(s);
    const view = await service().readAgentView({ companyId: s.companyId, agentId: s.agentId, now: clock });
    expect(view.enabled).toBe(true);
    expect(view.active.connectionId).toBe(s.fallbackId);
    expect(view.active.reason).toBe("account_exhausted");
    expect(view.pinnedIssues).toEqual([expect.objectContaining({ id: s.issueId, identifier: s.identifier, finished: false })]);
    expect(view.connections).toHaveLength(2);
    expect(view.connections[0]).toMatchObject({ id: "default", position: 1, isDefault: true, inUse: false,
      accountKey: `ai:${s.connectionId}`, exhaustedUntil: nextUtc20(clock).toISOString(), model: DEFAULT_MODEL });
    expect(view.connections[1]).toMatchObject({ id: s.fallbackId, position: 2, isDefault: false, inUse: true,
      accountKey: "login:opencode_local", exhaustedUntil: null, model: FALLBACK_MODEL });
    expect(view.today.switches).toBe(1);
    expect(view.timeline[0]).toMatchObject({ kind: "switched", fromModel: DEFAULT_MODEL, toModel: FALLBACK_MODEL });
    expect(view.timeline.some((event) => event.kind === "run" && event.status === "failed")).toBe(true);
    const active = await service().readCompanyActive(s.companyId);
    expect(active).toEqual([{ agentId: s.agentId, connectionId: s.fallbackId, adapterType: "opencode_local",
      model: FALLBACK_MODEL, isFallback: true }]);
  });

  it("accountKeyFor returns null only for configuration rejections and propagates other errors", async () => {
    const s = await seed();
    const agent = await s.loadAgent();
    const entry = buildChain(agent)[0]!;
    const keyInput = { companyId: s.companyId, agentId: s.agentId, responsibleUserId: null, entry };
    const rejecting = (error: Error) => createModelFallbackService(db, { now: () => clock,
      resolveAccountConnectionId: async () => { throw error; } });
    expect(await rejecting(aiConnectionConfigurationFailure("ai_connection_unavailable", "Reconnect")).accountKeyFor(keyInput))
      .toBeNull();
    expect(await rejecting(forbidden("This connection is not permitted for this agent")).accountKeyFor(keyInput)).toBeNull();
    const transient = rejecting(new Error("connection pool timeout"));
    await expect(transient.accountKeyFor(keyInput)).rejects.toThrow("connection pool timeout");
    await expect(transient.selectForDispatch({ agent, run: await s.loadRun(), responsibleUserId: null }))
      .rejects.toThrow("connection pool timeout");
    expect(await s.state()).toBeNull();
    expect(await s.actions("agent.model_fallback.switched")).toHaveLength(0);
  });

  it("a quota failure while on a fallback pins its issue, and the agent returns only after both finish", async () => {
    const s = await seed();
    const secondIssueId = randomUUID();
    await db.insert(issues).values({ id: secondIssueId, companyId: s.companyId, title: "Second task", status: "in_progress",
      assigneeAgentId: s.agentId, identifier: `${s.identifier}b` });
    // Y's run started on the default before X failed.
    const secondRun = await s.newRun(s.agentId, secondIssueId);
    await switchToFallback(s);
    expect((await s.state())?.pinnedIssueIds).toEqual([s.issueId]);

    await db.update(heartbeatRuns).set({ status: "failed", errorCode: "provider_quota", error: "Claude usage limit reached",
      resultJson: { message: "You've hit your limit · resets 20:00 (UTC)" },
      runnerProfileJson: { adapterDispatch: { modelFallback: s.defaultRecord } } }).where(eq(heartbeatRuns.id, secondRun.id));
    await service().recordQuotaFailure({ run: await s.loadRun(secondRun.id), agent: await s.loadAgent() });
    const state = await s.state();
    expect(state?.activeConnectionId).toBe(s.fallbackId);
    expect(state?.pinnedIssueIds).toEqual([s.issueId, secondIssueId]);

    await db.update(modelAccountExhaustions).set({ exhaustedUntil: new Date(clock.getTime() - 60_000) })
      .where(eq(modelAccountExhaustions.companyId, s.companyId));
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, s.issueId));
    const stillPinned = await service().selectForDispatch({ agent: await s.loadAgent(), run: await s.newRun(s.agentId, secondIssueId),
      responsibleUserId: null });
    expect(stillPinned.kind).toBe("stay");
    await db.update(issues).set({ status: "in_review" }).where(eq(issues.id, secondIssueId));
    const returned = await service().selectForDispatch({ agent: await s.loadAgent(), run: await s.newRun(), responsibleUserId: null });
    expect(returned.kind).toBe("return");
  });

  it("an unparsed failure does not shorten a parsed reset that is still ahead", async () => {
    const s = await seed();
    const today = new Date();
    clock = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), 8, 0, 0));
    await service().recordQuotaFailure({ run: await s.failQuota(s.defaultRecord), agent: await s.loadAgent() });
    const parsedReset = nextUtc20(clock).toISOString();
    expect((await s.exhaustions())[0]).toMatchObject({ parsedResetTime: true });

    const failUnparsed = async () => {
      const run = await s.newRun();
      await db.update(heartbeatRuns).set({ status: "failed", errorCode: "provider_quota", error: "Rate limited", resultJson: {},
        runnerProfileJson: { adapterDispatch: { modelFallback: s.defaultRecord } } }).where(eq(heartbeatRuns.id, run.id));
      await service().recordQuotaFailure({ run: await s.loadRun(run.id), agent: await s.loadAgent() });
    };
    await failUnparsed();
    let rows = await s.exhaustions();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.exhaustedUntil.toISOString()).toBe(parsedReset);
    expect(rows[0]!.parsedResetTime).toBe(true);
    expect(rows[0]!.sourceRunId).toBe(s.runId);

    // Once the stored reset has passed, the new observation wins.
    await db.update(modelAccountExhaustions).set({ exhaustedUntil: new Date(clock.getTime() - 60_000) })
      .where(eq(modelAccountExhaustions.companyId, s.companyId));
    await failUnparsed();
    rows = await s.exhaustions();
    expect(rows[0]!.exhaustedUntil.toISOString()).toBe(new Date(clock.getTime() + 60 * 60_000).toISOString());
    expect(rows[0]!.parsedResetTime).toBe(false);
  });
});
