import { and, eq, inArray, isNotNull, sql, type AnyColumn, type SQL } from "drizzle-orm";
import {
  agentModelFallbackStates,
  agents,
  heartbeatRuns,
  issues,
  modelAccountExhaustions,
  type Db,
} from "@paperclipai/db";
import {
  MODEL_FALLBACK_DEFAULT_CONNECTION_ID,
  MODEL_FALLBACK_FINISHED_ISSUE_STATUSES,
  MODEL_FALLBACK_RETRY_REASON,
  aiConnectionBindingSchema,
  modelFallbackConfigSchema,
  type AgentModelFallbackView,
  type CompanyModelFallbackActive,
  type ModelFallbackDispatchRecord,
} from "@paperclipai/shared";
import { parseObject } from "../../adapters/utils.js";
import { logger } from "../../middleware/logger.js";
import { logActivity, publishActivity, type ActivityPublication } from "../activity-log.js";
import { HttpError } from "../../errors.js";
import { readAiConnectionConfigurationFailure } from "../ai-connection-configuration-failure.js";
import { aiConnectionService } from "../ai-connections.js";
import { issueService } from "../issues.js";
import { boundRunIssueId } from "../run-task-binding.js";
import {
  PROVIDER_QUOTA_RECOVERY_DEFAULT_BACKOFF_MS,
  resolveProviderQuotaRetryAt,
} from "../recovery/provider-quota-retry-at.js";
import { buildChain, readDispatchRecord, selectConnection, type ChainEntry, type ModelFallbackSelectionKind } from "./policy.js";
import { readAgentModelFallbackView } from "./view.js";

export type AgentRow = typeof agents.$inferSelect;
export type HeartbeatRunRow = typeof heartbeatRuns.$inferSelect;

export const MODEL_FALLBACK_SWITCHED_ACTION = "agent.model_fallback.switched";
export const MODEL_FALLBACK_RETURNED_ACTION = "agent.model_fallback.returned";
const ACTIVITY_ACTOR_ID = "model_fallback";

export type AccountKeyInput = {
  companyId: string;
  agentId: string;
  responsibleUserId: string | null;
  entry: ChainEntry;
};

export type ModelFallbackServiceDeps = {
  now?: () => Date;
  /** Resolves the AI connection a bound chain entry would run on; null when it cannot be selected. */
  resolveAccountConnectionId?: (input: AccountKeyInput) => Promise<string | null>;
};

export type ModelFallbackDispatchKind = ModelFallbackSelectionKind | "legacy";

export type ModelFallbackDispatchResult = {
  adapterType: string;
  record: ModelFallbackDispatchRecord | null;
  /** The transition this dispatch performed; "legacy" when the agent has no fallback chain. */
  kind: ModelFallbackDispatchKind;
  /** The chain entry the run must use (pass to effectiveRunAgent); null on the legacy path. */
  entry: ChainEntry | null;
};

const HARNESS_NAMES: Record<string, string> = {
  claude_local: "Claude Code",
  codex_local: "Codex",
  opencode_local: "OpenCode Go",
};

export function entryModel(entry: Pick<ChainEntry, "adapterConfig">): string | null {
  const model = entry.adapterConfig.model;
  return typeof model === "string" && model.trim().length > 0 ? model : null;
}

/** "<harness name> · <model>", e.g. "OpenCode Go · opencode-go/glm-5.3". */
export function connectionLabel(entry: Pick<ChainEntry, "adapterType" | "adapterConfig">): string {
  const harness = HARNESS_NAMES[entry.adapterType] ?? entry.adapterType;
  const model = entryModel(entry);
  return model ? `${harness} · ${model}` : harness;
}

/** HH:mm in the server's local timezone. */
export function formatLocalClock(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function switchedComment(input: { fromModel: string; resetAt: Date | null; toLabel: string }): string {
  if (!input.resetAt) return `${input.fromModel} không dùng được → chuyển sang ${input.toLabel} để làm tiếp.`;
  return `${input.fromModel} hết token (reset ${formatLocalClock(input.resetAt)}) → chuyển sang ${input.toLabel} để làm tiếp.`;
}

export function returnedComment(input: { fromLabel: string; toLabel: string }): string {
  return `${input.fromLabel} → quay về ${input.toLabel} (mặc định).`;
}

export { readDispatchRecord };

function toRecord(
  chain: ChainEntry[],
  accountKeys: (string | null)[],
  index: number,
  kind: ModelFallbackSelectionKind,
): ModelFallbackDispatchRecord {
  const entry = chain[index]!;
  return {
    connectionId: entry.id,
    accountKey: accountKeys[index] ?? null,
    adapterType: entry.adapterType,
    model: entryModel(entry),
    isFallback: index > 0,
    kind,
  };
}

/** A configured fallback connection, read even while automatic switching is off (labels only). */
function configuredConnection(agent: AgentRow, connectionId: string): Pick<ChainEntry, "adapterType" | "adapterConfig"> | null {
  const raw = parseObject(parseObject(agent.runtimeConfig).modelFallback);
  const parsed = modelFallbackConfigSchema.safeParse({ ...raw, enabled: true });
  if (!parsed.success) return null;
  return parsed.data.connections.find((connection) => connection.id === connectionId) ?? null;
}

type DbOrTx = Pick<Db, "select" | "insert" | "update">;

async function loadExhaustions(db: DbOrTx, companyId: string, accountKeys: (string | null)[]) {
  const keys = [...new Set(accountKeys.filter((key): key is string => key !== null))];
  const exhaustedUntil = new Map<string, Date>();
  if (!keys.length) return exhaustedUntil;
  const rows = await db
    .select({ accountKey: modelAccountExhaustions.accountKey, exhaustedUntil: modelAccountExhaustions.exhaustedUntil })
    .from(modelAccountExhaustions)
    .where(and(eq(modelAccountExhaustions.companyId, companyId), inArray(modelAccountExhaustions.accountKey, keys)));
  for (const row of rows) exhaustedUntil.set(row.accountKey, row.exhaustedUntil);
  return exhaustedUntil;
}

/** Rule 7: every pinned issue is done/in_review/cancelled/blocked, gone, or no longer assigned to the agent. */
async function pinnedIssuesFinished(db: DbOrTx, companyId: string, agentId: string, pinnedIssueIds: string[]) {
  if (!pinnedIssueIds.length) return true;
  const rows = await db
    .select({ id: issues.id, status: issues.status, assigneeAgentId: issues.assigneeAgentId })
    .from(issues)
    .where(and(eq(issues.companyId, companyId), inArray(issues.id, pinnedIssueIds)));
  return rows.every((row) =>
    MODEL_FALLBACK_FINISHED_ISSUE_STATUSES.includes(row.status) || row.assigneeAgentId !== agentId);
}

/** In the exhaustion upsert: the stored column while its reset is ahead of `at` and not earlier than the new one. */
function keepStored(stored: AnyColumn, incoming: SQL, at: Date): SQL {
  const until = modelAccountExhaustions.exhaustedUntil;
  return sql`case when ${until} > ${at.toISOString()}::timestamptz and ${until} >= excluded.exhausted_until
    then ${stored} else ${incoming} end`;
}

/**
 * select() rejects a binding it cannot run with aiConnectionConfigurationFailure (and its
 * credential-not-shared variant), which record a reason, or with a plain 403 for membership,
 * ownership and install permission checks.
 */
function isSelectionRejection(error: unknown): boolean {
  if (readAiConnectionConfigurationFailure(error) !== null) return true;
  return error instanceof HttpError && error.status === 403;
}

type PendingComment ={ issueId: string; runId: string; body: string; title: string };

export function createModelFallbackService(db: Db, deps: ModelFallbackServiceDeps = {}) {
  const now = deps.now ?? (() => new Date());

  const resolveAccountConnectionId = deps.resolveAccountConnectionId ?? (async (input: AccountKeyInput) => {
    const binding = aiConnectionBindingSchema.parse(input.entry.aiConnection);
    const selection = await aiConnectionService(db).select({
      companyId: input.companyId,
      agentId: input.agentId,
      userId: input.responsibleUserId,
      adapterType: input.entry.adapterType,
      model: input.entry.adapterConfig.model,
      runnerProvider: input.entry.adapterConfig.provider,
      acpxAgent: input.entry.adapterConfig.acpxAgent,
      binding,
    });
    return selection.attribution.connectionId;
  });

  async function accountKeyFor(input: AccountKeyInput): Promise<string | null> {
    const binding = input.entry.aiConnection;
    // A machine login (OpenCode Go and other bindingless harnesses): the harness itself is the account.
    if (!binding) return `login:${input.entry.adapterType}`;
    // A router pool rotates its own accounts; the pool is the unit this chain can see.
    if (binding.mode === "router") return `router:${binding.connectionId}`;
    try {
      const connectionId = await resolveAccountConnectionId(input);
      return connectionId ? `ai:${connectionId}` : null;
    } catch (error) {
      // Only select()'s deliberate rejections mean "this connection cannot run"; anything else
      // (a DB or pool failure, a bug) must not quietly switch the agent away from its default.
      if (!isSelectionRejection(error)) throw error;
      logger.warn({
        companyId: input.companyId,
        agentId: input.agentId,
        entryId: input.entry.id,
        reason: readAiConnectionConfigurationFailure(error) ?? "forbidden",
      }, "model fallback connection cannot be selected");
      return null;
    }
  }

  async function chainAccountKeys(agent: Pick<AgentRow, "id" | "companyId">, chain: ChainEntry[], responsibleUserId: string | null) {
    return Promise.all(chain.map((entry) =>
      accountKeyFor({ companyId: agent.companyId, agentId: agent.id, responsibleUserId, entry })));
  }

  async function postComments(comments: PendingComment[]) {
    for (const comment of comments) {
      try {
        // Service-level addComment never enqueues an assignee wake (only the HTTP comment route does),
        // so a switch notice cannot start an extra run.
        await issueService(db).addComment(comment.issueId, comment.body, { runId: comment.runId }, {
          authorType: "system",
          presentation: {
            kind: "system_notice",
            tone: "info",
            title: comment.title,
            density: "compact",
            detailsDefaultOpen: false,
          },
        });
      } catch (error) {
        logger.warn({ err: error, issueId: comment.issueId, runId: comment.runId }, "model fallback comment failed");
      }
    }
  }

  /**
   * A default-only chain (switching disabled, chain removed, paperclip_runner) runs the default. A state row still
   * holding a fallback is cleared here, with a "disabled" return, so the tab, header and Office agree with the runs
   * and re-enabling never silently resumes the old fallback.
   */
  async function returnFromDefaultOnlyChain(agent: AgentRow, run: HeartbeatRunRow, chain: ChainEntry[]): Promise<ModelFallbackDispatchResult> {
    const legacy: ModelFallbackDispatchResult = { adapterType: agent.adapterType, record: null, kind: "legacy", entry: null };
    const scope = and(eq(agentModelFallbackStates.companyId, agent.companyId), eq(agentModelFallbackStates.agentId, agent.id));
    const held = await db
      .select({ activeConnectionId: agentModelFallbackStates.activeConnectionId })
      .from(agentModelFallbackStates)
      .where(and(scope, isNotNull(agentModelFallbackStates.activeConnectionId)))
      .then((rows) => rows[0] ?? null);
    if (!held) return legacy;

    const at = now();
    const runIssueId = boundRunIssueId(run);
    const publications: ActivityPublication[] = [];
    const comments: PendingComment[] = [];
    const to = chain[0]!;
    const returned = await db.transaction(async (tx) => {
      const state = await tx.select().from(agentModelFallbackStates).where(scope).for("update").then((rows) => rows[0] ?? null);
      if (!state?.activeConnectionId) return false;
      await tx
        .update(agentModelFallbackStates)
        .set({ activeConnectionId: null, pinnedIssueIds: [], switchedAt: null, reason: null, updatedAt: at })
        .where(and(scope, eq(agentModelFallbackStates.id, state.id)));
      const from = configuredConnection(agent, state.activeConnectionId);
      await logActivity(tx as unknown as Db, {
        companyId: agent.companyId,
        actorType: "system",
        actorId: ACTIVITY_ACTOR_ID,
        action: MODEL_FALLBACK_RETURNED_ACTION,
        entityType: "agent",
        entityId: agent.id,
        agentId: agent.id,
        runId: run.id,
        issueId: runIssueId,
        details: {
          from: state.activeConnectionId, to: to.id, reason: "disabled",
          fromAdapterType: from?.adapterType ?? null, fromModel: from ? entryModel(from) : null,
          toAdapterType: to.adapterType, toModel: entryModel(to), issueId: runIssueId,
        },
      }, publications);
      if (runIssueId) {
        comments.push({
          issueId: runIssueId,
          runId: run.id,
          body: returnedComment({ fromLabel: from ? connectionLabel(from) : "Kết nối dự phòng", toLabel: connectionLabel(to) }),
          title: `Quay về ${connectionLabel(to)}`,
        });
      }
      return true;
    });
    if (!returned) return legacy;
    for (const publication of publications) publishActivity(publication);
    await postComments(comments);
    // The account is not resolved: a default-only chain keeps the legacy quota path (recordQuotaFailure needs a key).
    return { adapterType: to.adapterType, record: toRecord(chain, [null], 0, "return"), kind: "return", entry: to };
  }

  async function selectForDispatch(input: {
    agent: AgentRow;
    run: HeartbeatRunRow;
    responsibleUserId: string | null;
  }): Promise<ModelFallbackDispatchResult> {
    const { agent, run } = input;
    const chain = buildChain(agent);
    // A run from another company or agent never moves this agent's state.
    if (run.companyId !== agent.companyId || run.agentId !== agent.id) {
      return { adapterType: agent.adapterType, record: null, kind: "legacy", entry: null };
    }
    if (chain.length <= 1) return returnFromDefaultOnlyChain(agent, run, chain);

    const at = now();
    const accountKeys = await chainAccountKeys(agent, chain, input.responsibleUserId);
    const runIssueId = boundRunIssueId(run);
    // Rule 12: a switch retry's task failed on the account this agent switched away from, so it holds the agent on
    // the fallback even when another run already switched it (two failures before either retry was claimed).
    const isSwitchRetry = run.scheduledRetryReason === MODEL_FALLBACK_RETRY_REASON;
    const publications: ActivityPublication[] = [];
    const comments: PendingComment[] = [];

    const outcome = await db.transaction(async (tx) => {
      const lockState = () => tx
        .select()
        .from(agentModelFallbackStates)
        .where(and(eq(agentModelFallbackStates.companyId, agent.companyId), eq(agentModelFallbackStates.agentId, agent.id)))
        .for("update")
        .then((rows) => rows[0] ?? null);

      let state = await lockState();
      for (;;) {
        const exhaustedUntil = await loadExhaustions(tx, agent.companyId, accountKeys);
        const pins = state?.pinnedIssueIds ?? [];
        const activeConnectionId = state?.activeConnectionId ?? null;
        const pinnedFinished = await pinnedIssuesFinished(tx, agent.companyId, agent.id, pins);
        const selection = selectConnection({ chain, accountKeys, exhaustedUntil, activeConnectionId, pinnedFinished, now: at });
        const foundIndex = activeConnectionId ? chain.findIndex((entry) => entry.id === activeConnectionId) : -1;
        const fromIndex = Math.max(0, foundIndex);
        // A switch that lands on the default is a return (rule 9: the fallback ran out and the default is back).
        const kind: ModelFallbackSelectionKind =
          selection.kind === "switch" && selection.index === 0 ? "return" : selection.kind;

        type Patch = Partial<typeof agentModelFallbackStates.$inferInsert>;
        let patch: Patch | null = null;
        let activity: { action: string; details: Record<string, unknown> } | null = null;
        let comment: Omit<PendingComment, "runId" | "issueId"> | null = null;

        if (kind === "switch") {
          const fromKey = accountKeys[fromIndex] ?? null;
          const fromUntil = fromKey ? exhaustedUntil.get(fromKey) : undefined;
          const resetAt = fromUntil && fromUntil.getTime() > at.getTime() ? fromUntil : null;
          const reason = resetAt ? "account_exhausted" : "account_unavailable";
          const from = chain[fromIndex]!;
          const to = chain[selection.index]!;
          patch = {
            activeConnectionId: to.id,
            pinnedIssueIds: runIssueId && !pins.includes(runIssueId) ? [...pins, runIssueId] : pins,
            switchedAt: at,
            reason,
          };
          activity = {
            action: MODEL_FALLBACK_SWITCHED_ACTION,
            details: {
              from: from.id, to: to.id, reason, resetAt: resetAt?.toISOString() ?? null,
              fromAdapterType: from.adapterType, fromModel: entryModel(from),
              toAdapterType: to.adapterType, toModel: entryModel(to), issueId: runIssueId,
            },
          };
          comment = {
            body: switchedComment({ fromModel: entryModel(from) ?? connectionLabel(from), resetAt, toLabel: connectionLabel(to) }),
            title: `Chuyển sang ${connectionLabel(to)}`,
          };
        } else if (kind === "return") {
          const from = chain[fromIndex]!;
          const to = chain[0]!;
          const reason = selection.kind === "return" ? "pinned_finished" : "fallback_unavailable";
          patch = { activeConnectionId: null, pinnedIssueIds: [], switchedAt: null, reason: null };
          activity = {
            action: MODEL_FALLBACK_RETURNED_ACTION,
            details: {
              from: from.id, to: to.id, reason,
              fromAdapterType: from.adapterType, fromModel: entryModel(from),
              toAdapterType: to.adapterType, toModel: entryModel(to), issueId: runIssueId,
            },
          };
          comment = {
            body: returnedComment({ fromLabel: connectionLabel(from), toLabel: connectionLabel(to) }),
            title: `Quay về ${connectionLabel(to)}`,
          };
        } else if (kind === "stay") {
          if (runIssueId && !pins.includes(runIssueId) && (!pins.length || isSwitchRetry)) {
            patch = { pinnedIssueIds: [...pins, runIssueId] };
          }
        } else if (kind === "default" && activeConnectionId) {
          // The active fallback was removed from the chain; its config edit is already in the activity log.
          patch = { activeConnectionId: null, pinnedIssueIds: [], switchedAt: null, reason: null };
        }

        if (patch && !state) {
          const inserted = await tx
            .insert(agentModelFallbackStates)
            .values({ companyId: agent.companyId, agentId: agent.id, ...patch, updatedAt: at })
            .onConflictDoNothing({ target: [agentModelFallbackStates.companyId, agentModelFallbackStates.agentId] })
            .returning();
          if (!inserted.length) {
            // A concurrent dispatch created the row; decide again under its lock.
            state = await lockState();
            continue;
          }
        } else if (patch && state) {
          await tx
            .update(agentModelFallbackStates)
            .set({ ...patch, updatedAt: at })
            .where(and(eq(agentModelFallbackStates.companyId, agent.companyId), eq(agentModelFallbackStates.id, state.id)));
        }
        if (activity) {
          await logActivity(tx as unknown as Db, {
            companyId: agent.companyId,
            actorType: "system",
            actorId: ACTIVITY_ACTOR_ID,
            action: activity.action,
            entityType: "agent",
            entityId: agent.id,
            agentId: agent.id,
            runId: run.id,
            issueId: runIssueId,
            details: activity.details,
          }, publications);
        }
        if (comment && runIssueId) comments.push({ ...comment, issueId: runIssueId, runId: run.id });
        return { index: selection.index, kind };
      }
    });

    for (const publication of publications) publishActivity(publication);
    await postComments(comments);
    const entry = chain[outcome.index]!;
    return { adapterType: entry.adapterType, record: toRecord(chain, accountKeys, outcome.index, outcome.kind), kind: outcome.kind, entry };
  }

  async function recordQuotaFailure(input: { run: HeartbeatRunRow; agent: AgentRow }): Promise<{ retryNow: boolean }> {
    const { run, agent } = input;
    const record = readDispatchRecord(run);
    if (!record || record.accountKey === null || run.companyId !== agent.companyId) return { retryNow: false };

    const at = now();
    const config = modelFallbackConfigSchema.safeParse(parseObject(agent.runtimeConfig).modelFallback);
    const waitMinutes = config.success ? config.data.noResetWaitMinutes : undefined;
    const backoffMs = waitMinutes ? waitMinutes * 60_000 : PROVIDER_QUOTA_RECOVERY_DEFAULT_BACKOFF_MS;
    // Like the recovery service, search the whole failure text so a reset inside resultJson is found.
    const errorText = [run.errorCode, run.error, JSON.stringify(run.resultJson ?? {})]
      .filter((part): part is string => typeof part === "string" && part.length > 0)
      .join(" ");
    const { retryAt, parsedResetTime } = resolveProviderQuotaRetryAt({ error: errorText, resultJson: run.resultJson }, at, backoffMs);

    await db
      .insert(modelAccountExhaustions)
      .values({
        companyId: run.companyId,
        accountKey: record.accountKey,
        exhaustedUntil: retryAt,
        sourceRunId: run.id,
        parsedResetTime,
        updatedAt: at,
      })
      .onConflictDoUpdate({
        target: [modelAccountExhaustions.companyId, modelAccountExhaustions.accountKey],
        // A stored reset that is still ahead and later than this observation is kept, with its
        // source and parsed flag: a concurrent failure without a reset time must not shorten it.
        set: {
          exhaustedUntil: keepStored(modelAccountExhaustions.exhaustedUntil, sql.raw("excluded.exhausted_until"), at),
          sourceRunId: keepStored(modelAccountExhaustions.sourceRunId, sql.raw("excluded.source_run_id"), at),
          parsedResetTime: keepStored(modelAccountExhaustions.parsedResetTime, sql.raw("excluded.parsed_reset_time"), at),
          updatedAt: at,
        },
      });

    // Rule 12: a task that fails while the agent is already on a fallback also holds the agent there.
    const failedIssueId = boundRunIssueId(run);
    if (failedIssueId) {
      const issueJson = JSON.stringify([failedIssueId]);
      await db
        .update(agentModelFallbackStates)
        .set({
          pinnedIssueIds: sql`case when ${agentModelFallbackStates.pinnedIssueIds} @> ${issueJson}::jsonb
            then ${agentModelFallbackStates.pinnedIssueIds}
            else ${agentModelFallbackStates.pinnedIssueIds} || ${issueJson}::jsonb end`,
          updatedAt: at,
        })
        .where(and(
          eq(agentModelFallbackStates.companyId, agent.companyId),
          eq(agentModelFallbackStates.agentId, agent.id),
          isNotNull(agentModelFallbackStates.activeConnectionId),
        ));
    }

    const chain = buildChain(agent);
    if (chain.length <= 1) return { retryNow: false };
    const accountKeys = await chainAccountKeys(agent, chain, run.responsibleUserId ?? null);
    const exhaustedUntil = await loadExhaustions(db, agent.companyId, accountKeys);
    const failedIndex = Math.max(0, chain.findIndex((entry) => entry.id === record.connectionId));
    const selection = selectConnection({
      chain, accountKeys, exhaustedUntil, activeConnectionId: record.connectionId, pinnedFinished: false, now: at,
    });
    return { retryNow: (selection.kind === "switch" || selection.kind === "return") && selection.index !== failedIndex };
  }

  async function readAgentView(input: { companyId: string; agentId: string; now?: Date; userId?: string | null }): Promise<AgentModelFallbackView> {
    return readAgentModelFallbackView(db, {
      ...input,
      now: input.now ?? now(),
      accountKeysFor: chainAccountKeys,
    });
  }

  async function readCompanyActive(companyId: string): Promise<CompanyModelFallbackActive> {
    const rows = await db
      .select({ state: agentModelFallbackStates, agent: agents })
      .from(agentModelFallbackStates)
      .innerJoin(agents, and(eq(agents.id, agentModelFallbackStates.agentId), eq(agents.companyId, companyId)))
      .where(and(eq(agentModelFallbackStates.companyId, companyId), isNotNull(agentModelFallbackStates.activeConnectionId)));
    const active: CompanyModelFallbackActive = [];
    for (const { state, agent } of rows) {
      const chain = buildChain(agent);
      const index = chain.findIndex((entry) => entry.id === state.activeConnectionId);
      if (index <= 0) continue;
      const entry = chain[index]!;
      active.push({
        agentId: agent.id,
        connectionId: entry.id,
        adapterType: entry.adapterType,
        model: entryModel(entry),
        isFallback: entry.id !== MODEL_FALLBACK_DEFAULT_CONNECTION_ID,
      });
    }
    return active;
  }

  return { accountKeyFor, selectForDispatch, recordQuotaFailure, readAgentView, readCompanyActive };
}
