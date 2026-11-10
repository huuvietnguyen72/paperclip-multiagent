import type { CostByAgent, CostSummary, HeartbeatRun, Issue } from "@paperclipai/shared";
import type { OfficeAgentView } from "./agent-state";

export interface StatBlock {
  doneCount: number;
  tokens: number;
  spendCents: number;
  runtimeMs: number;
}

export interface OfficeStats {
  company: StatBlock & { workingCount: number; shownCount: number; runtimeApproximate: boolean };
  byAgent: Map<string, StatBlock>;
}

/** First instant of the current UTC calendar month (same convention as the Costs page "mtd" range). */
export function utcMonthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

function toMs(value: Date | string | null | undefined): number | null {
  if (value == null) return null;
  const ms = typeof value === "string" ? Date.parse(value) : value.getTime();
  return Number.isFinite(ms) ? ms : null;
}

const emptyBlock = (): StatBlock => ({ doneCount: 0, tokens: 0, spendCents: 0, runtimeMs: 0 });

export function aggregateOfficeStats(a: {
  agents: OfficeAgentView[];
  issues: Issue[];
  runs: HeartbeatRun[];
  costSummary: CostSummary | null;
  costByAgent: CostByAgent[];
  now: Date;
  /** The page size the runs were fetched with; a full page that never reaches last month means older runs are missing. */
  runsLimit?: number;
}): OfficeStats {
  const monthStart = utcMonthStart(a.now).getTime();
  const nowMs = a.now.getTime();
  const byAgent = new Map<string, StatBlock>();
  const blockFor = (agentId: string) => {
    let block = byAgent.get(agentId);
    if (!block) {
      block = emptyBlock();
      byAgent.set(agentId, block);
    }
    return block;
  };
  for (const agent of a.agents) blockFor(agent.id);

  const company = { ...emptyBlock(), workingCount: 0, shownCount: a.agents.length, runtimeApproximate: false };
  if (a.runsLimit != null && a.runs.length >= a.runsLimit) {
    const starts = a.runs.map((run) => toMs(run.startedAt)).filter((ms): ms is number => ms != null);
    company.runtimeApproximate = starts.length > 0 && Math.min(...starts) >= monthStart;
  }

  for (const issue of a.issues) {
    const completedAt = toMs(issue.completedAt);
    if (issue.status !== "done" || completedAt == null || completedAt < monthStart) continue;
    company.doneCount += 1;
    if (issue.assigneeAgentId) blockFor(issue.assigneeAgentId).doneCount += 1;
  }

  for (const run of a.runs) {
    const startedAt = toMs(run.startedAt);
    if (startedAt == null) continue;
    const end = toMs(run.finishedAt) ?? nowMs;
    if (end < monthStart) continue;
    const ms = Math.max(0, end - Math.max(startedAt, monthStart));
    company.runtimeMs += ms;
    blockFor(run.agentId).runtimeMs += ms;
  }

  for (const row of a.costByAgent) {
    const tokens = (row.inputTokens ?? 0) + (row.cachedInputTokens ?? 0) + (row.outputTokens ?? 0);
    company.tokens += tokens;
    if (row.agentId) {
      const block = blockFor(row.agentId);
      block.tokens += tokens;
      block.spendCents += row.costCents ?? 0;
    }
  }
  company.spendCents = a.costSummary?.spendCents ?? 0;
  company.workingCount = a.agents.filter((agent) => agent.hasLiveRun).length;

  return { company, byAgent };
}

export function formatTokens(n: number): string {
  const compact = (value: number, suffix: string) => {
    const rounded = value >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
    return `${rounded}${suffix}`;
  };
  if (n >= 1_000_000_000) return compact(n / 1_000_000_000, "B");
  if (n >= 1_000_000) return compact(n / 1_000_000, "M");
  if (n >= 1_000) return compact(n / 1_000, "K");
  return String(Math.round(n));
}

const dollars = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function formatSpend(cents: number): string {
  return dollars.format(cents / 100);
}

export function formatDuration(ms: number): string {
  const totalMinutes = Math.floor(Math.max(0, ms) / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

export function formatAgo(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return "vừa xong";
  if (minutes < 60) return `${minutes} phút trước`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} giờ trước`;
  return `${Math.floor(hours / 24)} ngày trước`;
}

export function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(Math.max(0, ms) / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}
