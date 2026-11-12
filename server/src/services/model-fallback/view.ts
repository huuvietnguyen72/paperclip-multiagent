import { and, desc, eq, gte, inArray } from "drizzle-orm";
import {
  activityLog,
  agentConfigRevisions,
  agentModelFallbackStates,
  agents,
  heartbeatRuns,
  issues,
  modelAccountExhaustions,
  toolConnections,
  type Db,
} from "@paperclipai/db";
import {
  MODEL_FALLBACK_DEFAULT_CONNECTION_ID,
  MODEL_FALLBACK_FINISHED_ISSUE_STATUSES,
  modelFallbackConfigSchema,
  type AgentModelFallbackView,
  type ProviderQuotaResult,
} from "@paperclipai/shared";
import { parseObject } from "../../adapters/utils.js";
import { notFound } from "../../errors.js";
import { logger } from "../../middleware/logger.js";
import { aiConnectionService } from "../ai-connections.js";
import { fetchCompanyQuotaWindows } from "../quota-windows.js";
import { PROVIDER_QUOTA_RECOVERY_DEFAULT_BACKOFF_MS } from "../recovery/provider-quota-retry-at.js";
import { boundRunIssueId } from "../run-task-binding.js";
import { buildChain, type ChainEntry } from "./policy.js";

const TIMELINE_LIMIT = 50;
const QUOTA_WINDOW_TIMEOUT_MS = 5_000;
const SWITCHED = "agent.model_fallback.switched";
const RETURNED = "agent.model_fallback.returned";

type QuotaWindowView = AgentModelFallbackView["connections"][number]["quotaWindows"];
type TimelineEvent = AgentModelFallbackView["timeline"][number];

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function readNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function entryModel(entry: ChainEntry): string | null {
  return readString(entry.adapterConfig.model);
}

function runTokens(usage: unknown): number {
  const record = parseObject(usage);
  return readNumber(record.inputTokens ?? record.input_tokens) + readNumber(record.outputTokens ?? record.output_tokens);
}

function runConnectionId(runnerProfileJson: unknown): string | null {
  return readString(parseObject(parseObject(parseObject(runnerProfileJson).adapterDispatch).modelFallback).connectionId);
}

function runRecordModel(runnerProfileJson: unknown): string | null {
  return readString(parseObject(parseObject(parseObject(runnerProfileJson).adapterDispatch).modelFallback).model);
}

/** The chain as configured, even while automatic switching is off, so the tab can show it. */
function configuredChain(agent: typeof agents.$inferSelect): ChainEntry[] {
  const runtimeConfig = parseObject(agent.runtimeConfig);
  const modelFallback = parseObject(runtimeConfig.modelFallback);
  if (!Object.keys(modelFallback).length) return buildChain(agent);
  return buildChain({ ...agent, runtimeConfig: { ...runtimeConfig, modelFallback: { ...modelFallback, enabled: true } } });
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("quota windows timed out")), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Quota windows keyed by AI connection id. fetchCompanyQuotaWindows returns one row per
 * quotaAccounts() row, in order, with a hashed accountKey; the index (checked against the
 * row's provider and label) is what ties a row back to its connection.
 */
async function quotaWindowsByConnection(db: Db, companyId: string, userId: string): Promise<Map<string, QuotaWindowView>> {
  const byConnection = new Map<string, QuotaWindowView>();
  const accounts = await aiConnectionService(db).quotaAccounts(companyId, userId);
  if (!accounts.length) return byConnection;
  const results: ProviderQuotaResult[] = await fetchCompanyQuotaWindows(db, companyId, userId);
  if (results.length !== accounts.length) return byConnection;
  accounts.forEach((account, index) => {
    const result = results[index]!;
    if (!result.ok || result.provider !== account.summary.provider || result.accountLabel !== account.summary.name) return;
    byConnection.set(account.connection.id, result.windows.map((window) => ({
      label: window.label,
      usedPercent: window.usedPercent,
      resetsAt: window.resetsAt,
    })));
  });
  return byConnection;
}

export async function readAgentModelFallbackView(
  db: Db,
  input: {
    companyId: string;
    agentId: string;
    now: Date;
    /** The viewer; quota windows are read with their account visibility. */
    userId?: string | null;
    accountKeysFor: (
      agent: Pick<typeof agents.$inferSelect, "id" | "companyId">,
      chain: ChainEntry[],
      responsibleUserId: string | null,
    ) => Promise<(string | null)[]>;
  },
): Promise<AgentModelFallbackView> {
  const { companyId, agentId, now } = input;
  const agent = await db
    .select()
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)))
    .then((rows) => rows[0] ?? null);
  if (!agent) throw notFound("Agent not found");

  const config = modelFallbackConfigSchema.safeParse(parseObject(agent.runtimeConfig).modelFallback);
  const enabled = config.success ? config.data.enabled : false;
  const chain = configuredChain(agent);
  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);

  const [state, latestRun, runs, activities, revisions] = await Promise.all([
    db.select().from(agentModelFallbackStates)
      .where(and(eq(agentModelFallbackStates.companyId, companyId), eq(agentModelFallbackStates.agentId, agentId)))
      .then((rows) => rows[0] ?? null),
    db.select({ responsibleUserId: heartbeatRuns.responsibleUserId }).from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, agentId)))
      .orderBy(desc(heartbeatRuns.createdAt)).limit(1)
      .then((rows) => rows[0] ?? null),
    db.select().from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, agentId), gte(heartbeatRuns.createdAt, startOfDay)))
      .orderBy(desc(heartbeatRuns.createdAt)),
    db.select().from(activityLog)
      .where(and(eq(activityLog.companyId, companyId), eq(activityLog.agentId, agentId),
        inArray(activityLog.action, [SWITCHED, RETURNED]), gte(activityLog.createdAt, startOfDay))),
    db.select().from(agentConfigRevisions)
      .where(and(eq(agentConfigRevisions.companyId, companyId), eq(agentConfigRevisions.agentId, agentId),
        gte(agentConfigRevisions.createdAt, startOfDay))),
  ]);

  const responsibleUserId = latestRun?.responsibleUserId ?? input.userId ?? null;
  const accountKeys = await input.accountKeysFor(agent, chain, responsibleUserId);
  const keys = [...new Set(accountKeys.filter((key): key is string => key !== null))];
  const aiConnectionIds = keys.filter((key) => key.startsWith("ai:")).map((key) => key.slice(3));

  // While switching is off every run uses the default; a leftover state row (cleared at the next dispatch) is moot.
  const heldState = enabled ? state : null;
  const pinnedIssueIds = heldState?.pinnedIssueIds ?? [];
  const issueIds = new Set<string>(pinnedIssueIds);
  for (const run of runs) {
    const issueId = boundRunIssueId(run);
    if (issueId) issueIds.add(issueId);
  }
  for (const activity of activities) {
    const issueId = readString(parseObject(activity.details).issueId);
    if (issueId) issueIds.add(issueId);
  }

  const quotaUserId = input.userId ?? responsibleUserId;
  const [exhaustionRows, issueRows, connectionRows, quotaWindows] = await Promise.all([
    keys.length
      ? db.select().from(modelAccountExhaustions)
        .where(and(eq(modelAccountExhaustions.companyId, companyId), inArray(modelAccountExhaustions.accountKey, keys)))
      : Promise.resolve([]),
    issueIds.size
      ? db.select({ id: issues.id, identifier: issues.identifier, title: issues.title, status: issues.status,
        assigneeAgentId: issues.assigneeAgentId }).from(issues)
        .where(and(eq(issues.companyId, companyId), inArray(issues.id, [...issueIds])))
      : Promise.resolve([]),
    aiConnectionIds.length
      ? db.select({ id: toolConnections.id, name: toolConnections.name }).from(toolConnections)
        .where(and(eq(toolConnections.companyId, companyId), inArray(toolConnections.id, aiConnectionIds)))
      : Promise.resolve([]),
    quotaUserId && aiConnectionIds.length
      ? withTimeout(quotaWindowsByConnection(db, companyId, quotaUserId), QUOTA_WINDOW_TIMEOUT_MS).catch((error) => {
        logger.warn({ err: error, companyId, agentId }, "model fallback quota windows unavailable");
        return new Map<string, QuotaWindowView>();
      })
      : Promise.resolve(new Map<string, QuotaWindowView>()),
  ]);

  const exhaustedUntil = new Map(exhaustionRows.map((row) => [row.accountKey, row.exhaustedUntil]));
  const issueById = new Map(issueRows.map((row) => [row.id, row]));
  const connectionNames = new Map(connectionRows.map((row) => [row.id, row.name]));
  const activeIndex = heldState?.activeConnectionId
    ? chain.findIndex((entry) => entry.id === heldState.activeConnectionId) : -1;
  const activeId = chain[Math.max(0, activeIndex)]!.id;
  const chainIds = new Set(chain.map((entry) => entry.id));
  const connectionOfRun = (run: (typeof runs)[number]) => {
    const id = runConnectionId(run.runnerProfileJson) ?? MODEL_FALLBACK_DEFAULT_CONNECTION_ID;
    return chainIds.has(id) ? id : null;
  };

  const connections = chain.map((entry, index): AgentModelFallbackView["connections"][number] => {
    const accountKey = accountKeys[index] ?? null;
    const until = accountKey ? exhaustedUntil.get(accountKey) : undefined;
    const ownRuns = runs.filter((run) => connectionOfRun(run) === entry.id);
    const lastStarted = ownRuns.reduce<Date | null>((latest, run) =>
      run.startedAt && (!latest || run.startedAt > latest) ? run.startedAt : latest, null);
    const connectionId = accountKey?.startsWith("ai:") ? accountKey.slice(3) : null;
    return {
      id: entry.id,
      position: index + 1,
      isDefault: index === 0,
      adapterType: entry.adapterType,
      model: entryModel(entry),
      aiConnection: entry.aiConnection,
      accountKey,
      accountLabel: connectionId ? connectionNames.get(connectionId) ?? null : null,
      exhaustedUntil: until && until.getTime() > now.getTime() ? until.toISOString() : null,
      inUse: entry.id === activeId || ownRuns.some((run) => run.status === "running"),
      lastUsedAt: lastStarted?.toISOString() ?? null,
      runsToday: ownRuns.length,
      tokensToday: ownRuns.reduce((sum, run) => sum + runTokens(run.usageJson), 0),
      quotaWindows: connectionId ? quotaWindows.get(connectionId) ?? [] : [],
    };
  });

  const identifierOf = (issueId: string | null) => (issueId ? issueById.get(issueId)?.identifier ?? null : null);
  const timeline: TimelineEvent[] = [];
  for (const run of runs) {
    const at = run.startedAt ?? run.createdAt;
    timeline.push({
      at: at.toISOString(),
      kind: "run",
      status: run.status,
      issueIdentifier: identifierOf(boundRunIssueId(run)),
      model: runRecordModel(run.runnerProfileJson) ?? readString(parseObject(run.usageJson).model),
      durationMs: run.startedAt && run.finishedAt ? run.finishedAt.getTime() - run.startedAt.getTime() : null,
    });
  }
  for (const activity of activities) {
    const details = parseObject(activity.details);
    timeline.push({
      at: activity.createdAt.toISOString(),
      kind: activity.action === SWITCHED ? "switched" : "returned",
      issueIdentifier: identifierOf(readString(details.issueId)),
      fromModel: readString(details.fromModel),
      toModel: readString(details.toModel),
      reason: readString(details.reason),
      resetAt: readString(details.resetAt),
    });
  }
  for (const revision of revisions) {
    const before = parseObject(revision.beforeConfig);
    const after = parseObject(revision.afterConfig);
    const beforeModel = readString(parseObject(before.adapterConfig).model);
    const afterModel = readString(parseObject(after.adapterConfig).model);
    const bindingChanged = JSON.stringify(parseObject(before.runtimeConfig).aiConnection ?? null)
      !== JSON.stringify(parseObject(after.runtimeConfig).aiConnection ?? null);
    if (before.adapterType === after.adapterType && beforeModel === afterModel && !bindingChanged) continue;
    timeline.push({
      at: revision.createdAt.toISOString(),
      kind: "default_changed",
      fromModel: beforeModel,
      toModel: afterModel,
      reason: revision.source,
    });
  }
  timeline.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));

  return {
    enabled,
    noResetWaitMinutes: (config.success ? config.data.noResetWaitMinutes : undefined)
      ?? Math.round(PROVIDER_QUOTA_RECOVERY_DEFAULT_BACKOFF_MS / 60_000),
    active: {
      connectionId: activeId,
      since: activeIndex > 0 ? state?.switchedAt?.toISOString() ?? null : null,
      reason: activeIndex > 0 ? state?.reason ?? null : null,
    },
    pinnedIssues: pinnedIssueIds.flatMap((id) => {
      const issue = issueById.get(id);
      if (!issue) return [];
      return [{
        id: issue.id,
        identifier: issue.identifier ?? issue.id,
        title: issue.title,
        status: issue.status,
        finished: MODEL_FALLBACK_FINISHED_ISSUE_STATUSES.includes(issue.status) || issue.assigneeAgentId !== agentId,
      }];
    }),
    connections,
    today: {
      switches: activities.filter((activity) => activity.action === SWITCHED).length,
      tokens: runs.reduce((sum, run) => sum + runTokens(run.usageJson), 0),
    },
    timeline: timeline.slice(0, TIMELINE_LIMIT),
  };
}
