import { MODEL_FALLBACK_RETRY_REASON, type ModelFallbackDispatchRecord } from "@paperclipai/shared";
import { logger } from "../../middleware/logger.js";
import { routedRuntimeKeys } from "../ai-connection-router.js";
import { executionRetryAttemptCount } from "../execution-recovery-attempt.js";
import { buildChain, readDispatchRecord } from "./policy.js";
import type { AgentRow, createModelFallbackService, HeartbeatRunRow, ModelFallbackDispatchResult } from "./service.js";

/**
 * The narrow seams heartbeat uses. Every call is guarded (ruling P7): fallback bookkeeping that fails must never
 * stop an agent from running, so a failure falls back to the agent's own adapter and the existing retry branches.
 */
type ModelFallbackService = ReturnType<typeof createModelFallbackService>;
export type ModelFallbackDispatcher = Pick<ModelFallbackService, "selectForDispatch">;
export type ModelFallbackQuotaRecorder = Pick<ModelFallbackService, "recordQuotaFailure">;

/** The claim's runnerProfileJson.adapterDispatch value. */
export type AdapterDispatchJson = { adapterType: string; modelFallback?: ModelFallbackDispatchRecord };

export const MODEL_FALLBACK_SELECTION_FAILED_MESSAGE =
  "Model fallback selection failed; this run uses the agent's own model connection.";
export const MODEL_FALLBACK_CONNECTION_REMOVED_MESSAGE =
  "The model fallback connection chosen for this run was removed; the run cannot start under its claim. The next wake uses the current connection chain.";

export type ModelFallbackSwitchRetryOptions = {
  retryReason: string;
  wakeReason: string;
  delayMs: number;
  maxAttempts: number;
};

export function adapterDispatchJson(decision: Pick<ModelFallbackDispatchResult, "adapterType" | "record">): AdapterDispatchJson {
  return { adapterType: decision.adapterType, ...(decision.record ? { modelFallback: decision.record } : {}) };
}

/** One dispatch decision per claim; without a service, or when selection fails, the agent's own adapter. */
export async function adapterDispatchForClaim(
  service: ModelFallbackDispatcher | undefined,
  input: { agent: AgentRow; run: HeartbeatRunRow; responsibleUserId: string | null },
  warn: (message: string) => Promise<unknown>,
): Promise<AdapterDispatchJson> {
  const legacy: AdapterDispatchJson = { adapterType: input.agent.adapterType };
  if (!service) return legacy;
  try {
    return adapterDispatchJson(await service.selectForDispatch(input));
  } catch (error) {
    const scope = { companyId: input.run.companyId, agentId: input.agent.id, runId: input.run.id };
    logger.error({ ...scope, err: error }, "model fallback selection failed; dispatching the agent's own adapter");
    try {
      await warn(MODEL_FALLBACK_SELECTION_FAILED_MESSAGE);
    } catch (eventError) {
      logger.warn({ ...scope, err: eventError }, "model fallback selection warning could not be recorded");
    }
    return legacy;
  }
}

type ClaimedRun = { runnerProfileJson: unknown; scheduledRetryReason?: string | null };

/**
 * Ruling P9b. Explicit-resume session data belongs to the account that wrote it (and a switch retry copies the failed
 * run's context), so it is dropped whenever this run's account may differ from that one: a different adapter, a
 * fallback connection (even another account on the same harness), a model fallback switch retry, or a claim that
 * returned to the default.
 */
export function dropForeignAccountResumeSession(
  context: Record<string, unknown>,
  run: ClaimedRun,
  configuredAdapterType: string,
  dispatchedAdapterType: string,
): void {
  const record = readDispatchRecord(run);
  const accountMayDiffer = configuredAdapterType !== dispatchedAdapterType
    || record?.isFallback === true
    || record?.kind === "return"
    || run.scheduledRetryReason === MODEL_FALLBACK_RETRY_REASON;
  if (!accountMayDiffer) return;
  delete context.resumeSessionParams;
  delete context.resumeSessionDisplayId;
  delete context.resumeFromRunId;
}

/**
 * The issue's assignee overrides (the composer's model/effort picker) were chosen for the configured connection. On a
 * fallback connection, or another harness, they would send e.g. a Claude model to OpenCode, so the model-family keys
 * are dropped exactly as the router path drops them for a pool member; the other overrides still apply.
 */
export function dropFallbackIssueModelOverrides<T extends { adapterConfig: Record<string, unknown> | null }>(
  overrides: T | null,
  run: ClaimedRun,
  configuredAdapterType: string,
  dispatchedAdapterType: string,
): T | null {
  if (!overrides?.adapterConfig) return overrides;
  const onFallback = configuredAdapterType !== dispatchedAdapterType || readDispatchRecord(run)?.isFallback === true;
  if (!onFallback) return overrides;
  const kept = Object.fromEntries(Object.entries(overrides.adapterConfig).filter(([key]) => !routedRuntimeKeys.has(key)));
  return { ...overrides, adapterConfig: Object.keys(kept).length ? kept : null };
}

/**
 * Provider-quota completion hook (ruling P1). Records the failure against the agent as configured (the run's agent
 * may be a fallback copy) and returns immediate-retry options when another connection is usable now; null keeps the
 * existing retry branches. The switch shares the failure-retry budget with transient retries, so a chain whose budget
 * is already spent keeps the existing branches instead of ending in an exhausted switch.
 */
export async function modelFallbackSwitchRetry(
  service: ModelFallbackQuotaRecorder | undefined,
  run: HeartbeatRunRow,
  getAgent: (agentId: string) => Promise<AgentRow | null>,
): Promise<ModelFallbackSwitchRetryOptions | null> {
  if (!service) return null;
  try {
    const agent = await getAgent(run.agentId);
    if (!agent) return null;
    const { retryNow } = await service.recordQuotaFailure({ run, agent });
    const maxAttempts = buildChain(agent).length;
    if (!retryNow || executionRetryAttemptCount(run, MODEL_FALLBACK_RETRY_REASON) >= maxAttempts) return null;
    return { retryReason: MODEL_FALLBACK_RETRY_REASON, wakeReason: MODEL_FALLBACK_RETRY_REASON, delayMs: 0, maxAttempts };
  } catch (error) {
    logger.error({ companyId: run.companyId, agentId: run.agentId, runId: run.id, err: error },
      "model fallback quota bookkeeping failed; keeping the existing retry path");
    return null;
  }
}
