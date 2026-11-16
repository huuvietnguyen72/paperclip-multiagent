import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  agents, agentTaskSessions, agentWakeupRequests, companies, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, heartbeatRuns, issues,
  modelAccountExhaustions, type Db,
} from "@paperclipai/db";
import type { ModelFallbackDispatchRecord } from "@paperclipai/shared";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "../../__tests__/helpers/external-test-database.js";
import { createHeartbeatQueueTestDependencies } from "../../__tests__/helpers/heartbeat-queue.js";
import * as usageReceipts from "../usage-receipts.js";
import { createAgentIdentityRedactor } from "../agent-identity-redaction.js";
import { createHeartbeatQueue } from "../heartbeat/queue.js";
import { createHeartbeatLifecycle, type HeartbeatLifecycleDependencies } from "../heartbeat/run-lifecycle.js";
import { createHeartbeatRunCompletion, type CompleteHeartbeatRunInput, type HeartbeatRunCompletionDependencies } from "../heartbeat/run-completion.js";
import { ConfigurationIncompleteFailure, createHeartbeatRunPreparation } from "../heartbeat/run-preparation.js";
import { createHeartbeatRunState, getAdapterSessionCodec } from "../heartbeat/run-state.js";
import { buildEffectiveRunSessionConfigMetadata } from "../heartbeat/workspaces.js";
import * as dispatchWiring from "./dispatch-wiring.js";
import {
  adapterDispatchForClaim,
  adapterDispatchJson,
  dropFallbackIssueModelOverrides,
  dropForeignAccountResumeSession,
  MODEL_FALLBACK_SELECTION_FAILED_MESSAGE,
  modelFallbackSwitchRetry,
  modelFallbackUnusableTierRetry,
} from "./dispatch-wiring.js";
import { applyModelFallbackDispatch, buildChain } from "./policy.js";
import { createModelFallbackService } from "./service.js";

vi.mock("../live-events.js", () => ({ publishLiveEvent: vi.fn() }));

const FALLBACK_ID = "22222222-2222-4222-8222-222222222222";
const FALLBACK_MODEL = "opencode-go/glm-5.3";

function fallbackRuntimeConfig(connectionId = FALLBACK_ID) {
  return {
    modelFallback: {
      enabled: true,
      connections: [{ id: connectionId, adapterType: "opencode_local", adapterConfig: { model: FALLBACK_MODEL } }],
    },
  };
}

const configuredAgent = {
  id: "agent-1",
  adapterType: "claude_local",
  adapterConfig: { model: "claude-sonnet-5-5", cwd: "/work", instructionsFilePath: "/work/AGENTS.md" },
  runtimeConfig: fallbackRuntimeConfig(),
};

function fallbackRecord(patch: Partial<ModelFallbackDispatchRecord> = {}): ModelFallbackDispatchRecord {
  return {
    connectionId: FALLBACK_ID, accountKey: "login:opencode_local", adapterType: "opencode_local",
    model: FALLBACK_MODEL, isFallback: true, ...patch,
  };
}

function claimedRun(record: ModelFallbackDispatchRecord | null) {
  return {
    runnerProfileJson: {
      adapterDispatch: { adapterType: record?.adapterType ?? "claude_local", ...(record ? { modelFallback: record } : {}) },
    },
  };
}

describe("applyModelFallbackDispatch", () => {
  it("applyModelFallbackDispatch swaps adapter for fallback record", () => {
    const result = applyModelFallbackDispatch(configuredAgent, claimedRun(fallbackRecord()));
    expect(result.missing).toBe(false);
    expect(result.agent).toMatchObject({
      id: "agent-1",
      adapterType: "opencode_local",
      adapterConfig: { model: FALLBACK_MODEL, cwd: "/work", instructionsFilePath: "/work/AGENTS.md" },
    });
    // The configured agent is not mutated.
    expect(configuredAgent.adapterType).toBe("claude_local");
  });

  it("applyModelFallbackDispatch leaves agent when record missing", () => {
    const result = applyModelFallbackDispatch(configuredAgent, claimedRun(null));
    expect(result).toEqual({ agent: configuredAgent, missing: false });
    expect(applyModelFallbackDispatch(configuredAgent, { runnerProfileJson: null })).toEqual({ agent: configuredAgent, missing: false });
  });

  it("leaves agent for a default-connection record", () => {
    const record = fallbackRecord({ connectionId: "default", adapterType: "claude_local", isFallback: false });
    expect(applyModelFallbackDispatch(configuredAgent, claimedRun(record))).toEqual({ agent: configuredAgent, missing: false });
  });

  it("applyModelFallbackDispatch leaves agent when connection removed", () => {
    const withoutFallback = { ...configuredAgent, runtimeConfig: {} };
    expect(applyModelFallbackDispatch(withoutFallback, claimedRun(fallbackRecord()))).toEqual({ agent: withoutFallback, missing: true });
    const otherFallback = { ...configuredAgent, runtimeConfig: fallbackRuntimeConfig("33333333-3333-4333-8333-333333333333") };
    expect(applyModelFallbackDispatch(otherFallback, claimedRun(fallbackRecord()))).toEqual({ agent: otherFallback, missing: true });
  });
});

describe("dropForeignAccountResumeSession (ruling P9b)", () => {
  function resumeContext() {
    return {
      issueId: "issue-1",
      resumeFromRunId: "run-0",
      resumeSessionDisplayId: "claude-session",
      resumeSessionParams: { sessionId: "claude-session", cwd: "/work" },
    };
  }
  const defaultRecord = (kind: ModelFallbackDispatchRecord["kind"]) =>
    fallbackRecord({ connectionId: "default", accountKey: "ai:own", adapterType: "claude_local", model: "claude-sonnet-5-5", isFallback: false, kind });
  const drop = (run: { runnerProfileJson: unknown; scheduledRetryReason?: string | null }, dispatchedAdapterType = "claude_local") => {
    const context: Record<string, unknown> = resumeContext();
    dropForeignAccountResumeSession(context, run, "claude_local", dispatchedAdapterType);
    return context;
  };

  it("a fallback record plus resumeSessionParams in the context must not reach the fallback adapter", () => {
    const run = claimedRun(fallbackRecord());
    const { agent: runAgent } = applyModelFallbackDispatch(configuredAgent, run);
    expect(runAgent.adapterType).toBe("opencode_local");
    expect(drop(run, runAgent.adapterType)).toEqual({ issueId: "issue-1" });
  });

  it("keeps an explicit resume on the agent's own connection", () => {
    expect(drop(claimedRun(defaultRecord("default")))).toEqual(resumeContext());
    expect(drop(claimedRun(defaultRecord("stay")))).toEqual(resumeContext());
    expect(drop(claimedRun(null))).toEqual(resumeContext());
    expect(drop({ ...claimedRun(null), scheduledRetryReason: "transient_failure" })).toEqual(resumeContext());
  });

  it("drops it on a same-adapter fallback (another Claude account)", () => {
    const otherClaude = fallbackRecord({ accountKey: "ai:other", adapterType: "claude_local", model: "claude-sonnet-5-5", kind: "switch" });
    expect(drop(claimedRun(otherClaude))).toEqual({ issueId: "issue-1" });
    expect(drop(claimedRun({ ...otherClaude, kind: "stay" }))).toEqual({ issueId: "issue-1" });
  });

  it("drops it on a model fallback switch retry", () => {
    expect(drop({ ...claimedRun(defaultRecord("default")), scheduledRetryReason: "model_fallback_switch" })).toEqual({ issueId: "issue-1" });
    expect(drop({ ...claimedRun(null), scheduledRetryReason: "model_fallback_switch" })).toEqual({ issueId: "issue-1" });
  });

  it("drops it when the claim returned to the default", () => {
    expect(drop(claimedRun(defaultRecord("return")))).toEqual({ issueId: "issue-1" });
  });
});

describe("dropFallbackIssueModelOverrides", () => {
  const issueOverrides = () => ({
    adapterConfig: {
      model: "claude-opus-5", effort: "high", modelReasoningEffort: "high", reasoningEffort: "high", variant: "max",
      provider: "acpx", acpxAgent: "claude", workspaceStrategy: { type: "git_worktree" }, timeoutSec: 600,
    },
    useProjectWorkspace: true,
  });
  const kept = { adapterConfig: { workspaceStrategy: { type: "git_worktree" }, timeoutSec: 600 }, useProjectWorkspace: true };

  it("drops the issue's model picks when the run is dispatched to another harness", () => {
    expect(dropFallbackIssueModelOverrides(issueOverrides(), claimedRun(fallbackRecord()), "claude_local", "opencode_local")).toEqual(kept);
  });

  it("drops them on a same-harness fallback connection", () => {
    const otherClaude = fallbackRecord({ accountKey: "ai:other", adapterType: "claude_local", model: "claude-sonnet-5-5" });
    expect(dropFallbackIssueModelOverrides(issueOverrides(), claimedRun(otherClaude), "claude_local", "claude_local")).toEqual(kept);
  });

  it("keeps them on the configured connection", () => {
    const own = fallbackRecord({ connectionId: "default", adapterType: "claude_local", isFallback: false, kind: "return" });
    expect(dropFallbackIssueModelOverrides(issueOverrides(), claimedRun(own), "claude_local", "claude_local")).toEqual(issueOverrides());
    expect(dropFallbackIssueModelOverrides(issueOverrides(), claimedRun(null), "claude_local", "claude_local")).toEqual(issueOverrides());
    expect(dropFallbackIssueModelOverrides(null, claimedRun(fallbackRecord()), "claude_local", "opencode_local")).toBeNull();
  });

  it("leaves no adapterConfig when only model picks were set", () => {
    expect(dropFallbackIssueModelOverrides({ adapterConfig: { model: "claude-opus-5" }, useProjectWorkspace: null },
      claimedRun(fallbackRecord()), "claude_local", "opencode_local")).toEqual({ adapterConfig: null, useProjectWorkspace: null });
  });
});

describe("removed fallback connection keeps the claimed-adapter invariant", () => {
  it("has no bypass of the claimed adapter check", () => {
    expect("claimedAdapterForStart" in dispatchWiring).toBe(false);
  });
});

describe("claim dispatch json", () => {
  const agent = { id: "agent-1", companyId: "company-1", adapterType: "claude_local" } as typeof agents.$inferSelect;
  const run = { id: "run-1", companyId: "company-1", agentId: "agent-1" } as typeof heartbeatRuns.$inferSelect;

  it("writes the record next to the dispatched adapter", () => {
    expect(adapterDispatchJson({ adapterType: "opencode_local", record: fallbackRecord() }))
      .toEqual({ adapterType: "opencode_local", modelFallback: fallbackRecord() });
    expect(adapterDispatchJson({ adapterType: "claude_local", record: null })).toEqual({ adapterType: "claude_local" });
  });

  it("dispatches the agent's own adapter without a service", async () => {
    const warn = vi.fn(async () => undefined);
    expect(await adapterDispatchForClaim(undefined, { agent, run, responsibleUserId: null }, warn)).toEqual({ adapterType: "claude_local" });
    expect(warn).not.toHaveBeenCalled();
  });

  it("dispatches the agent's own adapter with no record when selection throws", async () => {
    const service = { selectForDispatch: vi.fn(async () => { throw new Error("database unavailable"); }) };
    const warn = vi.fn(async () => { throw new Error("event write failed too"); });
    expect(await adapterDispatchForClaim(service, { agent, run, responsibleUserId: "user-1" }, warn)).toEqual({ adapterType: "claude_local" });
    expect(service.selectForDispatch).toHaveBeenCalledWith({ agent, run, responsibleUserId: "user-1" });
    expect(warn).toHaveBeenCalledWith(MODEL_FALLBACK_SELECTION_FAILED_MESSAGE);
  });
});

describe("modelFallbackSwitchRetry", () => {
  const run = { id: "run-1", companyId: "company-1", agentId: "agent-1" } as typeof heartbeatRuns.$inferSelect;
  const stored = { ...configuredAgent, companyId: "company-1" } as unknown as typeof agents.$inferSelect;

  it("reads the configured agent and records the failure against it", async () => {
    const service = { recordQuotaFailure: vi.fn(async () => ({ retryNow: true })) };
    const getAgent = vi.fn(async () => stored);
    expect(await modelFallbackSwitchRetry(service, run, getAgent)).toEqual({
      retryReason: "model_fallback_switch", wakeReason: "model_fallback_switch", delayMs: 0, maxAttempts: 2,
    });
    expect(getAgent).toHaveBeenCalledWith("agent-1");
    expect(service.recordQuotaFailure).toHaveBeenCalledWith({ run, agent: stored });
  });

  it("keeps the existing branches when no switch is possible or bookkeeping fails", async () => {
    const getAgent = vi.fn(async () => stored);
    expect(await modelFallbackSwitchRetry(undefined, run, getAgent)).toBeNull();
    expect(await modelFallbackSwitchRetry({ recordQuotaFailure: vi.fn(async () => ({ retryNow: false })) }, run, getAgent)).toBeNull();
    expect(await modelFallbackSwitchRetry({ recordQuotaFailure: vi.fn(async () => { throw new Error("db down"); }) }, run, getAgent)).toBeNull();
    expect(await modelFallbackSwitchRetry({ recordQuotaFailure: vi.fn(async () => ({ retryNow: true })) }, run, async () => null)).toBeNull();
  });

  it("keeps the existing branches when the chain's failure-retry budget is already spent", async () => {
    const service = { recordQuotaFailure: vi.fn(async () => ({ retryNow: true })) };
    const getAgent = vi.fn(async () => stored);
    const retried = (failureRetries: number) => ({ ...run, scheduledRetryReason: "model_fallback_switch", scheduledRetryAttempt: failureRetries,
      contextSnapshot: { executionRetryAccounting: { version: 1, failureRetries, maxTurnContinuations: 0 } } }) as typeof heartbeatRuns.$inferSelect;
    expect(await modelFallbackSwitchRetry(service, retried(1), getAgent)).toMatchObject({ maxAttempts: 2 });
    expect(await modelFallbackSwitchRetry(service, retried(2), getAgent)).toBeNull();
    // The failure is still recorded so the next dispatch sees the exhausted account.
    expect(service.recordQuotaFailure).toHaveBeenCalledTimes(2);
  });
});

const MODEL_DISABLED = "Model access is disabled. Change model access at https://opencode.ai/console/wrk_01J/models.";

describe("modelFallbackUnusableTierRetry", () => {
  const stored = { ...configuredAgent, companyId: "company-1" } as unknown as typeof agents.$inferSelect;
  const failedRun = (record: ModelFallbackDispatchRecord | null, patch: Partial<typeof heartbeatRuns.$inferSelect> = {}) => ({
    id: "run-1", companyId: "company-1", agentId: "agent-1", status: "failed", errorCode: "adapter_failed", error: MODEL_DISABLED,
    resultJson: null, ...claimedRun(record), ...patch,
  }) as typeof heartbeatRuns.$inferSelect;

  it("records an unusable fallback tier and retries immediately", async () => {
    const service = { recordUnusableFailure: vi.fn(async () => ({ retryNow: true })) };
    const getAgent = vi.fn(async () => stored);
    const run = failedRun(fallbackRecord());
    expect(await modelFallbackUnusableTierRetry(service, run, getAgent)).toEqual({
      retryReason: "model_fallback_switch", wakeReason: "model_fallback_switch", delayMs: 0, maxAttempts: 2,
    });
    expect(service.recordUnusableFailure).toHaveBeenCalledWith({ run, agent: stored });
  });

  it("never touches the service for a default-tier run or an unclassified failure", async () => {
    const service = { recordUnusableFailure: vi.fn(async () => ({ retryNow: true })) };
    const getAgent = vi.fn(async () => stored);
    const onDefault = fallbackRecord({ connectionId: "default", adapterType: "claude_local", isFallback: false });
    expect(await modelFallbackUnusableTierRetry(service, failedRun(onDefault), getAgent)).toBeNull();
    expect(await modelFallbackUnusableTierRetry(service, failedRun(null), getAgent)).toBeNull();
    expect(await modelFallbackUnusableTierRetry(service, failedRun(fallbackRecord(), { error: "OpenCode exited with code 1" }), getAgent))
      .toBeNull();
    expect(await modelFallbackUnusableTierRetry(undefined, failedRun(fallbackRecord()), getAgent)).toBeNull();
    expect(service.recordUnusableFailure).not.toHaveBeenCalled();
    expect(getAgent).not.toHaveBeenCalled();
  });

  it("keeps the existing branches when no switch is possible, bookkeeping fails or the budget is spent", async () => {
    const getAgent = vi.fn(async () => stored);
    const run = failedRun(fallbackRecord());
    expect(await modelFallbackUnusableTierRetry({ recordUnusableFailure: vi.fn(async () => ({ retryNow: false })) }, run, getAgent)).toBeNull();
    expect(await modelFallbackUnusableTierRetry({ recordUnusableFailure: vi.fn(async () => { throw new Error("db down"); }) }, run, getAgent))
      .toBeNull();
    const spent = failedRun(fallbackRecord(), { scheduledRetryReason: "model_fallback_switch", scheduledRetryAttempt: 2,
      contextSnapshot: { executionRetryAccounting: { version: 1, failureRetries: 2, maxTurnContinuations: 0 } } });
    const service = { recordUnusableFailure: vi.fn(async () => ({ retryNow: true })) };
    expect(await modelFallbackUnusableTierRetry(service, spent, getAgent)).toBeNull();
    expect(service.recordUnusableFailure).toHaveBeenCalledOnce();
  });
});

describe("heartbeat start order (ruling P4)", () => {
  it("applies the dispatch record before the coordinator first reads the agent adapter", async () => {
    const source = await readFile(new URL("../heartbeat.ts", import.meta.url), "utf8");
    const start = source.indexOf("let agent = loadedAgent;");
    expect(start).toBeGreaterThan(0);
    const startup = source.slice(start);
    const applied = startup.indexOf("applyModelFallbackDispatch(agent, run)");
    expect(applied).toBeGreaterThan(0);
    expect(applied).toBeLessThan(startup.indexOf("agent.adapterType"));
    expect(applied).toBeLessThan(startup.indexOf("claimedAdapterType(run)"));
    expect(applied).toBeLessThan(startup.indexOf("getTaskSession("));
    // A removed fallback connection still fails the unchanged claimed-adapter check (new admission on next wake).
    expect(startup).toContain("const selectedAdapter = claimedAdapterType(run);");
    // Cross-adapter explicit resume data is dropped next to the conversation drop: after the failed-chat-retry
    // authorization (which rejects contexts carrying resume keys) and before the explicit resume read.
    const authorized = startup.indexOf("const isFailedChatRunRetry = await authorizeFailedChatRetryExecution();");
    const dropped = startup.indexOf("dropForeignAccountResumeSession(context, run, loadedAgent.adapterType, agent.adapterType)");
    const resumeRead = startup.indexOf("sessionCodec.deserialize(parseObject(context.resumeSessionParams))");
    expect(authorized).toBeGreaterThan(0);
    expect(dropped).toBeGreaterThan(authorized);
    expect(resumeRead).toBeGreaterThan(dropped);
    expect(resumeRead - dropped).toBeLessThan(600);
  });

  it("drops the issue's model picks before any reader of the issue overrides on a fallback run", async () => {
    const source = await readFile(new URL("../heartbeat.ts", import.meta.url), "utf8");
    const startup = source.slice(source.indexOf("let agent = loadedAgent;"));
    const parsed = startup.indexOf("let issueAssigneeOverrides =");
    const filtered = startup.indexOf(
      "issueAssigneeOverrides = dropFallbackIssueModelOverrides(issueAssigneeOverrides, run, loadedAgent.adapterType, agent.adapterType);");
    expect(parsed).toBeGreaterThan(0);
    expect(filtered).toBeGreaterThan(parsed);
    // Every later read (router overrides, the original copy, workspace config, session preparation) sees the filtered value.
    const firstRead = startup.indexOf("issueAssigneeOverrides", parsed + "let issueAssigneeOverrides =".length);
    expect(firstRead).toBe(filtered);
    expect(startup.indexOf("const originalAiIssueOverrides = issueAssigneeOverrides;")).toBeGreaterThan(filtered);
  });
});

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_MODEL_FALLBACK_TEST_DATABASE_URL");
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();
if (!support.supported) console.warn("Skipping model fallback wiring database tests");

describe.skipIf(!support.supported)("model fallback heartbeat wiring", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: Db;

  beforeAll(async () => {
    // Keep the accounting transaction real without reading provider receipt files.
    vi.spyOn(usageReceipts, "indexPendingUsageReceipts").mockResolvedValue(new Map());
    vi.spyOn(usageReceipts, "recoverPendingRunUsageReceipts").mockResolvedValue([]);
    if (!external) database = await startEmbeddedPostgresTestDatabase("paperclip-model-fallback-wiring-");
    db = createDb(external ?? database!.connectionString, { maxConnections: 6 });
    await db.execute(sql`set client_min_messages = warning`);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); vi.restoreAllMocks(); });
  beforeEach(async () => { await db.execute(sql`truncate table companies restart identity cascade`); });

  async function seedAgent(runtimeConfig: Record<string, unknown> = fallbackRuntimeConfig(), adapterType = "process") {
    const [company] = await db.insert(companies).values({ name: "Fallback wiring", issuePrefix: "FW" }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Worker", role: "engineer", status: "idle",
      adapterType, adapterConfig: {}, runtimeConfig }).returning();
    return { company, agent };
  }

  it("fallback run uses the fallback adapter's task session", async () => {
    const { company, agent } = await seedAgent(fallbackRuntimeConfig(), "claude_local");
    const taskKey = randomUUID();
    await db.insert(agentTaskSessions).values([
      { companyId: company.id, agentId: agent.id, adapterType: "claude_local", taskKey, sessionDisplayId: "claude-session" },
      { companyId: company.id, agentId: agent.id, adapterType: "opencode_local", taskKey, sessionDisplayId: "opencode-session" },
    ]);
    const { agent: runAgent } = applyModelFallbackDispatch(agent, claimedRun(fallbackRecord()));
    // Same lookup as the coordinator: getTaskSession(agent.companyId, agent.id, agent.adapterType, taskKey).
    const session = await createHeartbeatRunState(db).getTaskSession(runAgent.companyId, runAgent.id, runAgent.adapterType, taskKey);
    expect(runAgent.adapterType).toBe("opencode_local");
    expect(session).toMatchObject({ adapterType: "opencode_local", sessionDisplayId: "opencode-session" });
  });

  it("paperclip_runner agent with a configured chain dispatches legacy (ruling P8)", async () => {
    const { agent } = await seedAgent(fallbackRuntimeConfig(), "paperclip_runner");
    const run = { id: randomUUID(), companyId: agent.companyId, agentId: agent.id } as typeof heartbeatRuns.$inferSelect;
    const result = await createModelFallbackService(db).selectForDispatch({ agent, run, responsibleUserId: null });
    expect(result).toEqual({ adapterType: "paperclip_runner", record: null, kind: "legacy", entry: null });
    expect(adapterDispatchJson(result)).toEqual({ adapterType: "paperclip_runner" });
  });

  async function queuedFixture() {
    const { company, agent } = await seedAgent();
    const [issue] = await db.insert(issues).values({ companyId: company.id, title: "Queue task", status: "todo", assigneeAgentId: agent.id }).returning();
    const [wake] = await db.insert(agentWakeupRequests).values({ companyId: company.id, agentId: agent.id, source: "assignment", status: "claimed", claimedAt: new Date() }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, status: "queued",
      invocationSource: "assignment", wakeupRequestId: wake.id, startedAt: new Date(), responsibleUserId: "fallback-test-user",
      contextSnapshot: { issueId: issue.id } }).returning();
    await db.update(issues).set({ executionRunId: run.id, executionAgentNameKey: agent.name, executionLockedAt: new Date() }).where(eq(issues.id, issue.id));
    const deps = createHeartbeatQueueTestDependencies(db);
    deps.getAgent.mockResolvedValue(agent);
    return { agent, run, deps };
  }

  it("claims a run with the selected connection's dispatch record", async () => {
    const f = await queuedFixture();
    const record = fallbackRecord();
    const modelFallback = { selectForDispatch: vi.fn(async () => ({ adapterType: "opencode_local", record, kind: "switch" as const, entry: null })) };
    const claimed = await createHeartbeatQueue(db, { ...f.deps, modelFallback }).claimQueuedRun(f.run);
    expect(claimed).toMatchObject({ id: f.run.id, status: "running", responsibleUserId: "fallback-test-user" });
    expect(claimed!.runnerProfileJson).toMatchObject({ adapterDispatch: { adapterType: "opencode_local", modelFallback: record } });
    expect(modelFallback.selectForDispatch).toHaveBeenCalledOnce();
    expect(modelFallback.selectForDispatch).toHaveBeenCalledWith({
      agent: f.agent, run: expect.objectContaining({ id: f.run.id }), responsibleUserId: "fallback-test-user",
    });
  });

  it("claims on the agent's own adapter when fallback selection throws", async () => {
    const f = await queuedFixture();
    const modelFallback = { selectForDispatch: vi.fn(async () => { throw new Error("database unavailable"); }) };
    const claimed = await createHeartbeatQueue(db, { ...f.deps, modelFallback }).claimQueuedRun(f.run);
    expect(claimed).toMatchObject({ id: f.run.id, status: "running" });
    expect(claimed!.runnerProfileJson).toEqual({ adapterDispatch: { adapterType: "process" } });
    expect(f.deps.appendRunEvent).toHaveBeenCalledWith(expect.objectContaining({ id: f.run.id }),
      expect.objectContaining({ level: "warn", message: MODEL_FALLBACK_SELECTION_FAILED_MESSAGE }));
  });

  type Dependencies = HeartbeatRunCompletionDependencies;
  function completionCallbacks() {
    const state = createHeartbeatRunState(db);
    const lifecycleDeps = {
      ...state, ...createHeartbeatRunPreparation(db),
      issuesSvc: { addComment: vi.fn(), listReviewAttention: vi.fn() },
      recovery: { escalateStrandedAssignedIssue: vi.fn() },
      companySkills: { completeTestRunForIssue: vi.fn() },
      budgets: { getInvocationBlock: vi.fn(async () => null) },
      treeControlSvc: { getActivePauseHoldGate: vi.fn(async () => null) },
      enqueueWakeup: vi.fn(),
      getCurrentUserRedactionOptions: vi.fn(async () => ({ enabled: false })),
      getAgentInvokability: vi.fn<HeartbeatLifecycleDependencies["getAgentInvokability"]>(async () => ({ invokable: true })),
      emitTerminalAgentTaskRun: vi.fn(), budgetHooks: {},
    } satisfies HeartbeatLifecycleDependencies;
    const lifecycle = createHeartbeatLifecycle(db, lifecycleDeps);
    return {
      ...state, ...lifecycle,
      classifyAndPersistRunLiveness: vi.fn<Dependencies["classifyAndPersistRunLiveness"]>(async run => run),
      completeSkillTestRunForHeartbeatOutcome: vi.fn<Dependencies["completeSkillTestRunForHeartbeatOutcome"]>(async () => null),
      refreshContinuationSummaryForRun: vi.fn<Dependencies["refreshContinuationSummaryForRun"]>(async () => null),
      findRunIssueComment: vi.fn<Dependencies["findRunIssueComment"]>(async () => null),
      findLatestCompletedFinalAgentMessage: vi.fn<Dependencies["findLatestCompletedFinalAgentMessage"]>(async () => null),
      finalizeIssueCommentPolicy: vi.fn<Dependencies["finalizeIssueCommentPolicy"]>(async () => ({ outcome: "not_applicable", queuedRun: null })),
      handleIssueReviewPathDisposition: vi.fn<Dependencies["handleIssueReviewPathDisposition"]>(async () => undefined),
      handleRunLivenessContinuation: vi.fn<Dependencies["handleRunLivenessContinuation"]>(),
      handleSuccessfulRunHandoff: vi.fn<Dependencies["handleSuccessfulRunHandoff"]>(),
      updateRuntimeState: vi.fn<Dependencies["updateRuntimeState"]>(),
      scheduleBoundedRetryForRun: vi.fn<Dependencies["scheduleBoundedRetryForRun"]>(),
      scheduleInteractionContinuationInfrastructureRetryIfEligible: vi.fn<Dependencies["scheduleInteractionContinuationInfrastructureRetryIfEligible"]>(async () => null),
      timerClaimWasFirstHeartbeat: vi.fn<Dependencies["timerClaimWasFirstHeartbeat"]>(() => undefined),
      releaseIssueExecutionAndPromote: vi.fn<Dependencies["releaseIssueExecutionAndPromote"]>(async () => undefined),
      finalizeAgentStatus: vi.fn<Dependencies["finalizeAgentStatus"]>(async () => undefined),
      enqueueWakeup: vi.fn<Dependencies["enqueueWakeup"]>(),
      issuesSvc: { addComment: vi.fn<Dependencies["issuesSvc"]["addComment"]>() },
      recovery: { reconcileLegacyContinuation: vi.fn<Dependencies["recovery"]["reconcileLegacyContinuation"]>(), reconcileResolvedDependencyWakeBackstop: vi.fn<Dependencies["recovery"]["reconcileResolvedDependencyWakeBackstop"]>() },
      getCurrentUserRedactionOptions: lifecycleDeps.getCurrentUserRedactionOptions,
      budgetHooks: {},
      runLogStore: { finalize: vi.fn<Dependencies["runLogStore"]["finalize"]>(async () => ({ bytes: 1, sha256: "log-hash", compressed: true })) },
      traceStore: { finalize: vi.fn<Dependencies["traceStore"]["finalize"]>() },
      processRunCancellationSettlements: new Map<string, { settled: Promise<void>; failed: boolean }>(),
      failedProcessRunCancellations: new Map<string, { settled: Promise<void>; failed: boolean }>(),
    } satisfies Dependencies;
  }

  async function quotaFailure(runtimeConfig: Record<string, unknown>, modelFallback: Dependencies["modelFallback"]) {
    const { agent } = await seedAgent(runtimeConfig);
    const [wake] = await db.insert(agentWakeupRequests).values({ companyId: agent.companyId, agentId: agent.id, source: "on_demand", status: "claimed" }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: agent.companyId, agentId: agent.id, wakeupRequestId: wake.id,
      status: "running", runtimeMode: "legacy", startedAt: new Date() }).returning();
    const deps = { ...completionCallbacks(), modelFallback };
    const input: CompleteHeartbeatRunInput = {
      run, agent, issueId: null, issueRef: null, signal: new AbortController().signal,
      output: { handle: { store: "local_file", logRef: "test-log" }, outputProgressState: { pending: { bytes: 0 } }, flushOutputProgress: vi.fn(async () => {}), stdoutExcerpt: "", stderrExcerpt: "quota" },
      session: { runtimeForAdapter: { sessionId: null, sessionDisplayId: null }, previousSessionParams: null, taskKey: "quota-task", configuredModel: "test-model",
        sessionConfigMetadata: await buildEffectiveRunSessionConfigMetadata({ adapterType: agent.adapterType, effectiveAdapterConfig: {}, agentRuntimeConfig: {}, issueOverrides: null, workspaceConfig: null, environment: null, environmentEnv: null, projectEnv: null, routineEnv: null, runtimeSkills: [] }),
      },
      readFailureReportSecrets: () => [],
      adapterResult: { exitCode: 1, signal: null, timedOut: false, errorMessage: "You've hit your limit", errorCode: "provider_quota", provider: "test", model: "test-model" },
      sessionCodec: getAdapterSessionCodec(agent.adapterType), taskSessionForRun: null, sessionCompaction: { rotate: false, reason: null }, configFreshnessResultMetadata: { version: 1 }, runLedgerScope: {}, currentUserRedactionOptions: { enabled: false }, providerTraceCapture: true, onProviderTraceFinalized: vi.fn(), issueContext: null, onLog: vi.fn(async () => {}),
    };
    await createHeartbeatRunCompletion(db, deps).completeRun(input);
    const [failed] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    expect(failed).toMatchObject({ status: "failed", errorCode: "provider_quota" });
    return { agent, run, deps };
  }

  it("quota failure without dispatch record keeps legacy path", async () => {
    const f = await quotaFailure({}, createModelFallbackService(db));
    expect(f.deps.scheduleBoundedRetryForRun).toHaveBeenCalledOnce();
    expect(f.deps.scheduleBoundedRetryForRun).toHaveBeenCalledWith(expect.objectContaining({ id: f.run.id }), f.agent);
    expect(f.deps.scheduleBoundedRetryForRun.mock.calls[0]).toHaveLength(2);
  });

  it("quota failure with usable fallback retries immediately", async () => {
    const modelFallback = { recordQuotaFailure: vi.fn(async () => ({ retryNow: true })), recordUnusableFailure: vi.fn() };
    const f = await quotaFailure(fallbackRuntimeConfig(), modelFallback);
    expect(modelFallback.recordQuotaFailure).toHaveBeenCalledWith({
      run: expect.objectContaining({ id: f.run.id, errorCode: "provider_quota" }), agent: expect.objectContaining({ id: f.agent.id }),
    });
    expect(f.deps.scheduleBoundedRetryForRun).toHaveBeenCalledOnce();
    expect(f.deps.scheduleBoundedRetryForRun).toHaveBeenCalledWith(expect.objectContaining({ id: f.run.id }), f.agent, {
      retryReason: "model_fallback_switch", wakeReason: "model_fallback_switch", delayMs: 0, maxAttempts: buildChain(f.agent).length,
    });
    expect(buildChain(f.agent)).toHaveLength(2);
  });

  it("quota failure falls back to the transient retry when fallback bookkeeping throws", async () => {
    const modelFallback = { recordQuotaFailure: vi.fn(async () => { throw new Error("database unavailable"); }), recordUnusableFailure: vi.fn() };
    const f = await quotaFailure(fallbackRuntimeConfig(), modelFallback);
    expect(modelFallback.recordQuotaFailure).toHaveBeenCalledOnce();
    expect(modelFallback.recordUnusableFailure).not.toHaveBeenCalled();
    expect(f.deps.scheduleBoundedRetryForRun).toHaveBeenCalledOnce();
    expect(f.deps.scheduleBoundedRetryForRun.mock.calls[0]).toHaveLength(2);
  });

  const switchRetryOptions = (agent: typeof agents.$inferSelect) => ({
    retryReason: "model_fallback_switch", wakeReason: "model_fallback_switch", delayMs: 0, maxAttempts: buildChain(agent).length,
  });
  const defaultTierRecord = () => fallbackRecord({ connectionId: "default", accountKey: "login:process", adapterType: "process",
    model: null, isFallback: false });
  const exhaustionKeysOf = (companyId: string) => db.select({ accountKey: modelAccountExhaustions.accountKey })
    .from(modelAccountExhaustions).where(eq(modelAccountExhaustions.companyId, companyId)).then((rows) => rows.map((row) => row.accountKey));

  /** A claimed run on the given tier whose adapter reports OpenCode's "Model access is disabled" failure. */
  async function modelDisabledFailure(record: ModelFallbackDispatchRecord) {
    const { agent } = await seedAgent(fallbackRuntimeConfig());
    const [wake] = await db.insert(agentWakeupRequests).values({ companyId: agent.companyId, agentId: agent.id, source: "on_demand", status: "claimed" }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: agent.companyId, agentId: agent.id, wakeupRequestId: wake.id,
      status: "running", runtimeMode: "legacy", startedAt: new Date(), ...claimedRun(record) }).returning();
    const deps = { ...completionCallbacks(), modelFallback: createModelFallbackService(db) };
    const input: CompleteHeartbeatRunInput = {
      run, agent, issueId: null, issueRef: null, signal: new AbortController().signal,
      output: { handle: { store: "local_file", logRef: "test-log" }, outputProgressState: { pending: { bytes: 0 } }, flushOutputProgress: vi.fn(async () => {}), stdoutExcerpt: "", stderrExcerpt: "" },
      session: { runtimeForAdapter: { sessionId: null, sessionDisplayId: null }, previousSessionParams: null, taskKey: "unusable-task", configuredModel: FALLBACK_MODEL,
        sessionConfigMetadata: await buildEffectiveRunSessionConfigMetadata({ adapterType: agent.adapterType, effectiveAdapterConfig: {}, agentRuntimeConfig: {}, issueOverrides: null, workspaceConfig: null, environment: null, environmentEnv: null, projectEnv: null, routineEnv: null, runtimeSkills: [] }),
      },
      readFailureReportSecrets: () => [],
      adapterResult: { exitCode: 1, signal: null, timedOut: false, errorMessage: MODEL_DISABLED, errorCode: null, provider: "opencode-go", model: FALLBACK_MODEL },
      sessionCodec: getAdapterSessionCodec(agent.adapterType), taskSessionForRun: null, sessionCompaction: { rotate: false, reason: null }, configFreshnessResultMetadata: { version: 1 }, runLedgerScope: {}, currentUserRedactionOptions: { enabled: false }, providerTraceCapture: true, onProviderTraceFinalized: vi.fn(), issueContext: null, onLog: vi.fn(async () => {}),
    };
    await createHeartbeatRunCompletion(db, deps).completeRun(input);
    const [failed] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    expect(failed).toMatchObject({ status: "failed", errorCode: "adapter_failed", error: MODEL_DISABLED });
    return { agent, run, deps };
  }

  it("a fallback-tier model-disabled failure marks the model and retries immediately on the next tier", async () => {
    const f = await modelDisabledFailure(fallbackRecord());
    expect(await exhaustionKeysOf(f.agent.companyId)).toEqual([`login:opencode_local#model:${FALLBACK_MODEL}`]);
    expect(f.deps.scheduleBoundedRetryForRun).toHaveBeenCalledOnce();
    expect(f.deps.scheduleBoundedRetryForRun).toHaveBeenCalledWith(expect.objectContaining({ id: f.run.id }), f.agent, switchRetryOptions(f.agent));
  });

  it("the same failure on the default tier keeps the legacy path", async () => {
    const f = await modelDisabledFailure(defaultTierRecord());
    expect(await exhaustionKeysOf(f.agent.companyId)).toEqual([]);
    expect(f.deps.scheduleBoundedRetryForRun).not.toHaveBeenCalled();
  });

  /** A claimed run on the given tier whose setup fails because its AI account must be reconnected. */
  async function accountUnavailableSetupFailure(record: ModelFallbackDispatchRecord) {
    const { agent } = await seedAgent(fallbackRuntimeConfig());
    const [wake] = await db.insert(agentWakeupRequests).values({ companyId: agent.companyId, agentId: agent.id, source: "on_demand", status: "claimed" }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: agent.companyId, agentId: agent.id, wakeupRequestId: wake.id,
      status: "running", runtimeMode: "legacy", startedAt: new Date(), ...claimedRun(record) }).returning();
    const deps = { ...completionCallbacks(), modelFallback: createModelFallbackService(db) };
    // The setup path chains .catch on the scheduled retry, like the real (async) scheduler.
    deps.scheduleBoundedRetryForRun.mockResolvedValue(null as never);
    const outerErr = new ConfigurationIncompleteFailure("Reconnect or validate the selected AI account",
      { configurationIncomplete: { reason: "ai_connection_unavailable" } });
    await createHeartbeatRunCompletion(db, deps).failRunSetup({ run, runId: run.id, outerErr, signal: new AbortController().signal,
      providerDispatchStarted: false, identityRedactor: createAgentIdentityRedactor(), readFailureReportSecrets: () => [] });
    const [failed] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    expect(failed).toMatchObject({ status: "failed", errorCode: "configuration_incomplete" });
    return { agent, run, deps };
  }

  it("a fallback-tier account that must be reconnected is marked and the run retries immediately", async () => {
    const f = await accountUnavailableSetupFailure(fallbackRecord());
    expect(await exhaustionKeysOf(f.agent.companyId)).toEqual(["login:opencode_local"]);
    expect(f.deps.scheduleBoundedRetryForRun).toHaveBeenCalledOnce();
    expect(f.deps.scheduleBoundedRetryForRun).toHaveBeenCalledWith(expect.objectContaining({ id: f.run.id }),
      expect.objectContaining({ id: f.agent.id }), switchRetryOptions(f.agent));
    expect(f.deps.scheduleInteractionContinuationInfrastructureRetryIfEligible).not.toHaveBeenCalled();
  });

  it("the same setup failure on the default tier keeps the legacy path", async () => {
    const f = await accountUnavailableSetupFailure(defaultTierRecord());
    expect(await exhaustionKeysOf(f.agent.companyId)).toEqual([]);
    expect(f.deps.scheduleBoundedRetryForRun).not.toHaveBeenCalled();
    expect(f.deps.scheduleInteractionContinuationInfrastructureRetryIfEligible).toHaveBeenCalledOnce();
  });
});
