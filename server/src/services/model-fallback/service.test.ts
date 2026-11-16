import { randomUUID } from "node:crypto";
import {
  activityLog, agentConfigRevisions, agentModelFallbackStates, agents, companies, companyMemberships, createDb,
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, heartbeatRuns, issueComments, issues, modelAccountExhaustions, toolApplications, toolConnections, type Db,
} from "@paperclipai/db";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveExternalTestDatabaseUrl } from "../../__tests__/helpers/external-test-database.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { forbidden } from "../../errors.js";
import { aiConnectionConfigurationFailure } from "../ai-connection-configuration-failure.js";
import { aiConnectionService } from "../ai-connections.js";
import { deleteCompany } from "../company-deletion.js";
import { PROVIDER_QUOTA_RECOVERY_DEFAULT_BACKOFF_MS } from "../recovery/provider-quota-retry-at.js";
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
      adapterType: "opencode_local", model: FALLBACK_MODEL, isFallback: true, kind: "switch" });
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
    expect(result.record).toMatchObject({ connectionId: "default", isFallback: false, kind: "return" });
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

  it("an account-only default change is one default_changed event with both account labels; a chain-only change is none", async () => {
    const s = await seed();
    const [app] = await db.insert(toolApplications).values({ companyId: s.companyId, name: "Anthropic app", type: "mcp_http" }).returning();
    const newConnectionId = randomUUID();
    await db.insert(toolConnections).values([
      { id: s.connectionId, companyId: s.companyId, applicationId: app!.id, name: "My Claude subscription", uid: randomUUID(), transport: "mcp_remote" },
      { id: newConnectionId, companyId: s.companyId, applicationId: app!.id, name: "Anthropic", uid: randomUUID(), transport: "mcp_remote" },
    ]);
    const config = (aiConnection: unknown, modelFallback: unknown = null) => ({
      adapterType: "claude_local",
      adapterConfig: { model: DEFAULT_MODEL },
      runtimeConfig: { aiConnection, ...(modelFallback ? { modelFallback } : {}) },
    });
    const bound = (connectionId: string) => ({ provider: "anthropic", method: "subscription", mode: "shared", connectionId, grantId: randomUUID() });
    const oldBinding = bound(s.connectionId), newBinding = bound(newConnectionId);
    await db.insert(agentConfigRevisions).values([
      { companyId: s.companyId, agentId: s.agentId, source: "patch", beforeConfig: config(oldBinding),
        afterConfig: config(newBinding), createdAt: new Date(clock.getTime() - 2_000) },
      { companyId: s.companyId, agentId: s.agentId, source: "patch", beforeConfig: config(newBinding),
        afterConfig: config(newBinding, { enabled: true, connections: [] }), createdAt: new Date(clock.getTime() - 1_000) },
    ]);
    const view = await service().readAgentView({ companyId: s.companyId, agentId: s.agentId, now: clock });
    const changes = view.timeline.filter((event) => event.kind === "default_changed");
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ fromAdapterType: "claude_local", toAdapterType: "claude_local",
      fromAccountLabel: "My Claude subscription", toAccountLabel: "Anthropic" });
    expect(changes[0]!.reason ?? null).toBeNull();
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

  it("a switch retry pins its issue even when the agent is already on the fallback (rule 12)", async () => {
    const s = await seed();
    const secondIssueId = randomUUID();
    await db.insert(issues).values({ id: secondIssueId, companyId: s.companyId, title: "Second task", status: "in_progress",
      assigneeAgentId: s.agentId, identifier: `${s.identifier}c` });
    // Both default runs fail before either switch retry is claimed: no state row exists yet, so no failure pin.
    const secondRun = await s.newRun(s.agentId, secondIssueId);
    await service().recordQuotaFailure({ run: await s.failQuota(s.defaultRecord), agent: await s.loadAgent() });
    await db.update(heartbeatRuns).set({ status: "failed", errorCode: "provider_quota", error: "Claude usage limit reached",
      resultJson: { message: "You've hit your limit · resets 20:00 (UTC)" },
      runnerProfileJson: { adapterDispatch: { modelFallback: s.defaultRecord } } }).where(eq(heartbeatRuns.id, secondRun.id));
    await service().recordQuotaFailure({ run: await s.loadRun(secondRun.id), agent: await s.loadAgent() });
    expect(await s.state()).toBeNull();

    const switchRetry = async (issueId: string) => {
      const run = await s.newRun(s.agentId, issueId);
      await db.update(heartbeatRuns).set({ scheduledRetryReason: "model_fallback_switch", scheduledRetryAttempt: 1 })
        .where(eq(heartbeatRuns.id, run.id));
      return service().selectForDispatch({ agent: await s.loadAgent(), run: await s.loadRun(run.id), responsibleUserId: null });
    };
    expect((await switchRetry(s.issueId)).kind).toBe("switch");
    expect((await switchRetry(secondIssueId)).kind).toBe("stay");
    expect((await s.state())?.pinnedIssueIds).toEqual([s.issueId, secondIssueId]);

    await db.update(modelAccountExhaustions).set({ exhaustedUntil: new Date(clock.getTime() - 60_000) })
      .where(eq(modelAccountExhaustions.companyId, s.companyId));
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, s.issueId));
    expect((await service().selectForDispatch({ agent: await s.loadAgent(), run: await s.newRun(), responsibleUserId: null })).kind)
      .toBe("stay");
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, secondIssueId));
    expect((await service().selectForDispatch({ agent: await s.loadAgent(), run: await s.newRun(), responsibleUserId: null })).kind)
      .toBe("return");
  });

  it("an unresolvable default key with a usable fallback stays on the default (ruling P10)", async () => {
    const s = await seed();
    const unresolvedDefault = createModelFallbackService(db, { now: () => clock,
      resolveAccountConnectionId: async ({ entry }) => (entry.id === "default" ? null : resolveAccountConnectionId({ entry })) });
    const result = await unresolvedDefault.selectForDispatch({ agent: await s.loadAgent(), run: await s.loadRun(), responsibleUserId: null });
    expect(result.adapterType).toBe("claude_local");
    expect(result.kind).toBe("default");
    expect(result.record).toMatchObject({ connectionId: "default", accountKey: null, isFallback: false });
    expect(await s.state()).toBeNull();
    expect(await s.actions("agent.model_fallback.switched")).toHaveLength(0);
  });

  it("a responsible_user default does not flap between runs with and without a user", async () => {
    const s = await seed();
    const agent = await s.loadAgent();
    const runtimeConfig = { ...(agent.runtimeConfig as Record<string, unknown>),
      aiConnection: { provider: "anthropic", method: "subscription", mode: "responsible_user" } };
    await db.update(agents).set({ runtimeConfig }).where(eq(agents.id, s.agentId));
    // Like select(): a responsible_user binding resolves only when the run names its user.
    const perUser = createModelFallbackService(db, { now: () => clock,
      resolveAccountConnectionId: async ({ entry, responsibleUserId }) =>
        (entry.id === "default" ? (responsibleUserId ? s.connectionId : null) : resolveAccountConnectionId({ entry })) });
    for (const responsibleUserId of [null, "user-1", null, "user-1"]) {
      const result = await perUser.selectForDispatch({ agent: await s.loadAgent(), run: await s.newRun(), responsibleUserId });
      expect(result.adapterType).toBe("claude_local");
      expect(result.kind).toBe("default");
    }
    expect(await s.state()).toBeNull();
    expect(await s.actions("agent.model_fallback.switched")).toHaveLength(0);
  });

  it("disabling automatic switching while on a fallback returns to the default and clears the state", async () => {
    const s = await seed();
    await switchToFallback(s);
    const agent = await s.loadAgent();
    const runtimeConfig = agent.runtimeConfig as { modelFallback: Record<string, unknown> };
    await db.update(agents).set({ runtimeConfig: { ...runtimeConfig, modelFallback: { ...runtimeConfig.modelFallback, enabled: false } } })
      .where(eq(agents.id, s.agentId));

    // Before any dispatch, the tab already shows the default in use.
    const disabledView = await service().readAgentView({ companyId: s.companyId, agentId: s.agentId, now: clock });
    expect(disabledView.enabled).toBe(false);
    expect(disabledView.active).toEqual({ connectionId: "default", since: null, reason: null });
    expect(disabledView.connections.find((connection) => connection.id === s.fallbackId)?.inUse).toBe(false);

    const result = await service().selectForDispatch({ agent: await s.loadAgent(), run: await s.newRun(), responsibleUserId: null });
    expect(result.adapterType).toBe("claude_local");
    expect(result.kind).toBe("return");
    expect(result.record).toMatchObject({ connectionId: "default", isFallback: false, kind: "return" });
    const state = await s.state();
    expect(state).toMatchObject({ activeConnectionId: null, pinnedIssueIds: [], switchedAt: null, reason: null });
    const returned = await s.actions("agent.model_fallback.returned");
    expect(returned).toHaveLength(1);
    expect(returned[0]!.details).toMatchObject({ from: s.fallbackId, to: "default", reason: "disabled", issueId: s.issueId });
    expect((await s.systemComments()).map((comment) => comment.body)).toContain(
      `OpenCode Go · ${FALLBACK_MODEL} → quay về Claude Code · ${DEFAULT_MODEL} (mặc định).`,
    );

    // A second dispatch has nothing to clear; re-enabling does not resume the old fallback.
    const again = await service().selectForDispatch({ agent: await s.loadAgent(), run: await s.newRun(), responsibleUserId: null });
    expect(again).toMatchObject({ kind: "legacy", record: null });
    expect(await s.actions("agent.model_fallback.returned")).toHaveLength(1);
    await db.update(agents).set({ runtimeConfig }).where(eq(agents.id, s.agentId));
    await db.update(modelAccountExhaustions).set({ exhaustedUntil: new Date(clock.getTime() - 60_000) })
      .where(eq(modelAccountExhaustions.companyId, s.companyId));
    const reenabled = await service().selectForDispatch({ agent: await s.loadAgent(), run: await s.newRun(), responsibleUserId: null });
    expect(reenabled.kind).toBe("default");
    expect(reenabled.adapterType).toBe("claude_local");
  });

  it("company deletion removes the fallback state and account exhaustion rows", async () => {
    const s = await seed();
    await switchToFallback(s);
    expect(await s.state()).not.toBeNull();
    expect(await s.exhaustions()).toHaveLength(1);
    await db.update(agents).set({ lifecycleState: "terminated", status: "terminated" }).where(eq(agents.companyId, s.companyId));
    expect(await deleteCompany(db, s.companyId)).toMatchObject({ id: s.companyId });
    expect(await db.select().from(modelAccountExhaustions).where(eq(modelAccountExhaustions.companyId, s.companyId))).toEqual([]);
    expect(await db.select().from(agentModelFallbackStates).where(eq(agentModelFallbackStates.companyId, s.companyId))).toEqual([]);
    expect(await db.select().from(companies).where(eq(companies.id, s.companyId))).toEqual([]);
  }, 60_000);

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

  describe("an unusable fallback tier", () => {
    const MODEL_DISABLED = "Model access is disabled. Change model access at https://opencode.ai/console/wrk_01J/models.";
    const glmKey = `login:opencode_local#model:${FALLBACK_MODEL}`;
    const claudeBinding = (connectionId: string) =>
      ({ provider: "anthropic", method: "subscription", mode: "shared", connectionId, grantId: randomUUID() });

    /** Replaces the agent's fallback chain; returns the configured connection ids in order. */
    async function configureChain(s: Awaited<ReturnType<typeof seed>>, connections: Record<string, unknown>[],
      extra: Record<string, unknown> = {}) {
      const agent = await s.loadAgent();
      const runtimeConfig = { ...(agent.runtimeConfig as Record<string, unknown>),
        modelFallback: { enabled: true, connections, ...extra } };
      await db.update(agents).set({ runtimeConfig }).where(eq(agents.id, s.agentId));
    }

    /** Fails a dispatched run with the given failure, as run completion persists it. */
    async function failDispatched(s: Awaited<ReturnType<typeof seed>>, runId: string, record: unknown,
      failure: { errorCode: string; error: string; resultJson?: Record<string, unknown> }) {
      await db.update(heartbeatRuns).set({ status: "failed", startedAt: clock, finishedAt: clock, resultJson: {}, ...failure,
        runnerProfileJson: { adapterDispatch: { modelFallback: record } } }).where(eq(heartbeatRuns.id, runId));
      return s.loadRun(runId);
    }

    it("reproduces the incident: a disabled GLM tier is left for the next usable Claude account, task kept", async () => {
      const s = await seed();
      const revokedId = randomUUID(), glmId = randomUUID(), newClaudeId = randomUUID();
      const revokedConnection = randomUUID(), newConnection = randomUUID();
      await configureChain(s, [
        { id: revokedId, adapterType: "claude_local", adapterConfig: { model: DEFAULT_MODEL }, aiConnection: claudeBinding(revokedConnection) },
        { id: glmId, adapterType: "opencode_local", adapterConfig: { model: FALLBACK_MODEL } },
        { id: newClaudeId, adapterType: "claude_local", adapterConfig: { model: DEFAULT_MODEL }, aiConnection: claudeBinding(newConnection) },
      ], { noResetWaitMinutes: 30 });
      // The revoked Anthropic connection cannot be selected, exactly like the live instance.
      const live = createModelFallbackService(db, { now: () => clock,
        resolveAccountConnectionId: async ({ entry }) => {
          const connectionId = await resolveAccountConnectionId({ entry });
          return connectionId === revokedConnection ? null : connectionId;
        } });

      // 00:21 the default hits its session limit; 00:24 the next claim skips the revoked tier and lands on GLM.
      await live.recordQuotaFailure({ run: await s.failQuota(s.defaultRecord), agent: await s.loadAgent() });
      const onGlm = await live.selectForDispatch({ agent: await s.loadAgent(), run: await s.newRun(), responsibleUserId: null });
      expect(onGlm).toMatchObject({ adapterType: "opencode_local", kind: "switch",
        record: { connectionId: glmId, accountKey: "login:opencode_local", model: FALLBACK_MODEL, isFallback: true } });
      expect(await s.state()).toMatchObject({ activeConnectionId: glmId, pinnedIssueIds: [s.issueId] });

      // The GLM run fails because the provider switched the model off.
      const glmRun = await s.newRun();
      const failedGlm = await failDispatched(s, glmRun.id, onGlm.record, { errorCode: "adapter_failed", error: MODEL_DISABLED });
      expect(await live.recordUnusableFailure({ run: failedGlm, agent: await s.loadAgent() })).toEqual({ retryNow: true });
      const marked = (await s.exhaustions()).find((row) => row.accountKey === glmKey);
      expect(marked).toMatchObject({ parsedResetTime: false, sourceRunId: glmRun.id });
      expect(marked!.exhaustedUntil.toISOString()).toBe(new Date(clock.getTime() + 30 * 60_000).toISOString());
      // The OpenCode login itself is not marked: other OpenCode models stay usable.
      expect((await s.exhaustions()).some((row) => row.accountKey === "login:opencode_local")).toBe(false);

      // The immediate retry's claim moves on to the working Claude account; the task stays pinned.
      const retry = await s.newRun();
      await db.update(heartbeatRuns).set({ scheduledRetryReason: "model_fallback_switch", scheduledRetryAttempt: 1 })
        .where(eq(heartbeatRuns.id, retry.id));
      const moved = await live.selectForDispatch({ agent: await s.loadAgent(), run: await s.loadRun(retry.id), responsibleUserId: null });
      expect(moved).toMatchObject({ adapterType: "claude_local", kind: "switch",
        record: { connectionId: newClaudeId, accountKey: `ai:${newConnection}`, model: DEFAULT_MODEL, isFallback: true } });
      expect(await s.state()).toMatchObject({ activeConnectionId: newClaudeId, pinnedIssueIds: [s.issueId], reason: "model_unusable" });
      const switched = await s.actions("agent.model_fallback.switched");
      expect(switched.map((row) => row.details)).toContainEqual(expect.objectContaining({
        from: glmId, to: newClaudeId, reason: "model_unusable", resetAt: null, fromModel: FALLBACK_MODEL, toModel: DEFAULT_MODEL,
      }));
      expect((await s.systemComments()).map((comment) => comment.body)).toContain(
        `OpenCode Go · ${FALLBACK_MODEL} không dùng được (model bị tắt) → chuyển sang Claude Code · ${DEFAULT_MODEL} để làm tiếp.`,
      );

      // The tab shows the GLM tier as out until its cool-down ends.
      const view = await live.readAgentView({ companyId: s.companyId, agentId: s.agentId, now: clock });
      expect(view.connections.find((connection) => connection.id === glmId)?.exhaustedUntil)
        .toBe(marked!.exhaustedUntil.toISOString());
      expect(view.active).toMatchObject({ connectionId: newClaudeId, reason: "model_unusable" });
    });

    it("keeps another model on the same OpenCode account usable and uses the default cool-down", async () => {
      const s = await seed();
      const glmId = randomUUID(), deepseekId = randomUUID();
      await configureChain(s, [
        { id: glmId, adapterType: "opencode_local", adapterConfig: { model: FALLBACK_MODEL } },
        { id: deepseekId, adapterType: "opencode_local", adapterConfig: { model: "opencode-go/deepseek-v4" } },
      ]);
      await service().recordQuotaFailure({ run: await s.failQuota(s.defaultRecord), agent: await s.loadAgent() });
      const onGlm = await service().selectForDispatch({ agent: await s.loadAgent(), run: await s.newRun(), responsibleUserId: null });
      expect(onGlm.record?.connectionId).toBe(glmId);

      const glmRun = await s.newRun();
      const failed = await failDispatched(s, glmRun.id, onGlm.record, { errorCode: "adapter_failed", error: MODEL_DISABLED });
      expect(await service().recordUnusableFailure({ run: failed, agent: await s.loadAgent() })).toEqual({ retryNow: true });
      const marked = (await s.exhaustions()).find((row) => row.accountKey === glmKey);
      expect(marked!.exhaustedUntil.toISOString())
        .toBe(new Date(clock.getTime() + PROVIDER_QUOTA_RECOVERY_DEFAULT_BACKOFF_MS).toISOString());

      const next = await service().selectForDispatch({ agent: await s.loadAgent(), run: await s.newRun(), responsibleUserId: null });
      expect(next).toMatchObject({ kind: "switch",
        record: { connectionId: deepseekId, accountKey: "login:opencode_local", model: "opencode-go/deepseek-v4" } });

      // After the cool-down GLM is tried again (the owner may have re-enabled it): the agent stays on DeepSeek, but GLM
      // is no longer marked out in the tab.
      clock = new Date(clock.getTime() + PROVIDER_QUOTA_RECOVERY_DEFAULT_BACKOFF_MS + 60_000);
      const view = await service().readAgentView({ companyId: s.companyId, agentId: s.agentId, now: clock });
      expect(view.connections.find((connection) => connection.id === glmId)?.exhaustedUntil).toBeNull();
    });

    it("marks the whole account when a fallback account cannot authenticate", async () => {
      const s = await seed();
      const otherClaudeId = randomUUID(), glmId = randomUUID(), otherConnection = randomUUID();
      await configureChain(s, [
        { id: otherClaudeId, adapterType: "claude_local", adapterConfig: { model: DEFAULT_MODEL }, aiConnection: claudeBinding(otherConnection) },
        { id: glmId, adapterType: "opencode_local", adapterConfig: { model: FALLBACK_MODEL } },
      ]);
      await service().recordQuotaFailure({ run: await s.failQuota(s.defaultRecord), agent: await s.loadAgent() });
      const onOther = await service().selectForDispatch({ agent: await s.loadAgent(), run: await s.newRun(), responsibleUserId: null });
      expect(onOther.record).toMatchObject({ connectionId: otherClaudeId, accountKey: `ai:${otherConnection}` });

      const run = await s.newRun();
      const failed = await failDispatched(s, run.id, onOther.record, { errorCode: "claude_auth_required", error: "Please run /login" });
      expect(await service().recordUnusableFailure({ run: failed, agent: await s.loadAgent() })).toEqual({ retryNow: true });
      // Its own key, never the account's quota exhaustion key.
      expect((await s.exhaustions()).map((row) => row.accountKey)).not.toContain(`ai:${otherConnection}`);
      expect((await s.exhaustions()).find((row) => row.accountKey === `ai:${otherConnection}#unusable`))
        .toMatchObject({ parsedResetTime: false, sourceRunId: run.id });

      const next = await service().selectForDispatch({ agent: await s.loadAgent(), run: await s.newRun(), responsibleUserId: null });
      expect(next.record?.connectionId).toBe(glmId);
      const switched = await s.actions("agent.model_fallback.switched");
      expect(switched.map((row) => row.details)).toContainEqual(expect.objectContaining({
        from: otherClaudeId, to: glmId, reason: "account_unusable", resetAt: null }));
      expect((await s.systemComments()).map((comment) => comment.body)).toContain(
        `Claude Code · ${DEFAULT_MODEL} không dùng được (tài khoản không truy cập được) → chuyển sang OpenCode Go · ${FALLBACK_MODEL} để làm tiếp.`,
      );
    });

    it("does not retry now when no other tier is usable", async () => {
      const s = await seed();
      await service().recordQuotaFailure({ run: await s.failQuota(s.defaultRecord), agent: await s.loadAgent() });
      const onGlm = await service().selectForDispatch({ agent: await s.loadAgent(), run: await s.newRun(), responsibleUserId: null });
      const run = await s.newRun();
      const failed = await failDispatched(s, run.id, onGlm.record, { errorCode: "adapter_failed", error: MODEL_DISABLED });
      expect(await service().recordUnusableFailure({ run: failed, agent: await s.loadAgent() })).toEqual({ retryNow: false });
      expect((await s.exhaustions()).map((row) => row.accountKey)).toContain(glmKey);
    });

    it("never marks anything for a run on the default connection or an unclassified failure", async () => {
      const s = await seed();
      const run = await s.newRun();
      const onDefault = await failDispatched(s, run.id, s.defaultRecord, { errorCode: "adapter_failed", error: MODEL_DISABLED });
      expect(await service().recordUnusableFailure({ run: onDefault, agent: await s.loadAgent() })).toEqual({ retryNow: false });
      const fallbackRecord = { connectionId: s.fallbackId, accountKey: "login:opencode_local", adapterType: "opencode_local",
        model: FALLBACK_MODEL, isFallback: true };
      const crash = await failDispatched(s, run.id, fallbackRecord, { errorCode: "adapter_failed", error: "OpenCode exited with code 1" });
      expect(await service().recordUnusableFailure({ run: crash, agent: await s.loadAgent() })).toEqual({ retryNow: false });
      expect(await s.exhaustions()).toHaveLength(0);
    });

    /** Agent Y whose DEFAULT is the given connection (one of agent X's fallbacks), with a fallback of its own. */
    async function insertCrossDefaultAgent(s: Awaited<ReturnType<typeof seed>>, defaults: {
      adapterType: string; adapterConfig: Record<string, unknown>; aiConnection?: Record<string, unknown>;
    }, fallback: Record<string, unknown>) {
      const id = randomUUID();
      await db.insert(agents).values({ id, companyId: s.companyId, name: `Y-${id.slice(0, 6)}`, role: "engineer", status: "idle",
        adapterType: defaults.adapterType, adapterConfig: defaults.adapterConfig,
        runtimeConfig: { heartbeat: { enabled: false }, ...(defaults.aiConnection ? { aiConnection: defaults.aiConnection } : {}),
          modelFallback: { enabled: true, connections: [fallback] } } });
      return id;
    }

    it("an unusable fallback ACCOUNT never takes another agent's default on that account (ruling P10)", async () => {
      const s = await seed();
      const otherClaudeId = randomUUID(), glmId = randomUUID(), otherConnection = randomUUID();
      await configureChain(s, [
        { id: otherClaudeId, adapterType: "claude_local", adapterConfig: { model: DEFAULT_MODEL }, aiConnection: claudeBinding(otherConnection) },
        { id: glmId, adapterType: "opencode_local", adapterConfig: { model: FALLBACK_MODEL } },
      ]);
      const agentY = await insertCrossDefaultAgent(s,
        { adapterType: "claude_local", adapterConfig: { model: DEFAULT_MODEL }, aiConnection: claudeBinding(otherConnection) },
        { id: randomUUID(), adapterType: "opencode_local", adapterConfig: { model: FALLBACK_MODEL } });

      await service().recordQuotaFailure({ run: await s.failQuota(s.defaultRecord), agent: await s.loadAgent() });
      const onOther = await service().selectForDispatch({ agent: await s.loadAgent(), run: await s.newRun(), responsibleUserId: null });
      const run = await s.newRun();
      const failed = await failDispatched(s, run.id, onOther.record, { errorCode: "claude_auth_required", error: "Please run /login" });
      await service().recordUnusableFailure({ run: failed, agent: await s.loadAgent() });

      // Y keeps running its own default (a broken default must surface to the owner, not be hidden by a switch).
      const onY = await service().selectForDispatch({ agent: await s.loadAgent(agentY), run: await s.newRun(agentY, null),
        responsibleUserId: null });
      expect(onY).toMatchObject({ kind: "default", adapterType: "claude_local",
        record: { connectionId: "default", accountKey: `ai:${otherConnection}`, isFallback: false } });
      expect(await s.state(agentY)).toBeNull();
      // X itself moves on.
      const onX = await service().selectForDispatch({ agent: await s.loadAgent(), run: await s.newRun(), responsibleUserId: null });
      expect(onX.record?.connectionId).toBe(glmId);
    });

    it("an unusable fallback MODEL never takes another agent's default on that model (ruling P10)", async () => {
      const s = await seed();
      const glmId = randomUUID(), otherClaudeId = randomUUID(), otherConnection = randomUUID();
      await configureChain(s, [
        { id: glmId, adapterType: "opencode_local", adapterConfig: { model: FALLBACK_MODEL } },
        { id: otherClaudeId, adapterType: "claude_local", adapterConfig: { model: DEFAULT_MODEL }, aiConnection: claudeBinding(otherConnection) },
      ]);
      // Like the owner's CEO: the default is the OpenCode model that other agents use as a fallback.
      const agentY = await insertCrossDefaultAgent(s, { adapterType: "opencode_local", adapterConfig: { model: FALLBACK_MODEL } },
        { id: randomUUID(), adapterType: "claude_local", adapterConfig: { model: DEFAULT_MODEL }, aiConnection: claudeBinding(otherConnection) });

      await service().recordQuotaFailure({ run: await s.failQuota(s.defaultRecord), agent: await s.loadAgent() });
      const onGlm = await service().selectForDispatch({ agent: await s.loadAgent(), run: await s.newRun(), responsibleUserId: null });
      const run = await s.newRun();
      const failed = await failDispatched(s, run.id, onGlm.record, { errorCode: "adapter_failed", error: MODEL_DISABLED });
      await service().recordUnusableFailure({ run: failed, agent: await s.loadAgent() });
      expect((await s.exhaustions()).map((row) => row.accountKey)).toContain(glmKey);

      const onY = await service().selectForDispatch({ agent: await s.loadAgent(agentY), run: await s.newRun(agentY, null),
        responsibleUserId: null });
      expect(onY).toMatchObject({ kind: "default", adapterType: "opencode_local",
        record: { connectionId: "default", accountKey: "login:opencode_local", model: FALLBACK_MODEL, isFallback: false } });
      const viewY = await service().readAgentView({ companyId: s.companyId, agentId: agentY, now: clock });
      expect(viewY.connections[0]).toMatchObject({ isDefault: true, exhaustedUntil: null });
      const onX = await service().selectForDispatch({ agent: await s.loadAgent(), run: await s.newRun(), responsibleUserId: null });
      expect(onX.record?.connectionId).toBe(otherClaudeId);
    });
  });
});
