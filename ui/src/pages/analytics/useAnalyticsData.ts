import { useMemo } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import type { CostByAgentModel } from "@paperclipai/shared";
import { agentsApi } from "@/api/agents";
import { costsApi } from "@/api/costs";
import { heartbeatsApi } from "@/api/heartbeats";
import type { AnalyticsRange } from "@/lib/analytics/date-range";
import type { RunSpan } from "@/lib/analytics/work-time";

export interface AnalyticsData {
  /** Shown agents in a stable order (by name); series colours follow this order. */
  agents: Array<{ id: string; name: string }>;
  runs: RunSpan[];
  costRows: CostByAgentModel[];
  isLoading: boolean;
  error: Error | null;
  /** True when some agent's run history was cut off by the page size inside the range. */
  approximate: boolean;
}

const HIDDEN_STATUSES = new Set(["terminated", "pending_approval"]);
/** Server maximum page size for heartbeat runs; fetched per agent so one busy agent cannot crowd out the rest. */
const RUNS_LIMIT = 1000;
const REFRESH_MS = 60_000;

export function useAnalyticsData(companyId: string, range: AnalyticsRange): AnalyticsData {
  const agentsQuery = useQuery({
    queryKey: ["analytics", companyId, "agents"],
    queryFn: () => agentsApi.list(companyId),
    refetchInterval: REFRESH_MS,
  });
  const agents = useMemo(
    () =>
      (agentsQuery.data ?? [])
        .filter((agent) => !HIDDEN_STATUSES.has(agent.status))
        .map((agent) => ({ id: agent.id, name: agent.name }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [agentsQuery.data],
  );

  const runQueries = useQueries({
    queries: agents.map((agent) => ({
      queryKey: ["analytics", companyId, "runs", agent.id],
      queryFn: () => heartbeatsApi.list(companyId, agent.id, RUNS_LIMIT, { summary: true }),
      refetchInterval: REFRESH_MS,
    })),
  });

  const from = range.start.toISOString();
  const to = range.end.toISOString();
  const costQuery = useQuery({
    queryKey: ["analytics", companyId, "costByAgentModel", from, to],
    queryFn: () => costsApi.byAgentModel(companyId, from, to),
    refetchInterval: REFRESH_MS,
  });

  const runsKey = runQueries.map((query) => query.dataUpdatedAt).join(",");
  const { runs, approximate } = useMemo(() => {
    const all: RunSpan[] = [];
    let cut = false;
    for (const query of runQueries) {
      const list = query.data ?? [];
      for (const run of list) all.push({ agentId: run.agentId, startedAt: run.startedAt, finishedAt: run.finishedAt });
      if (list.length >= RUNS_LIMIT) {
        const oldest = Math.min(...list.map((run) => (run.startedAt ? new Date(run.startedAt).getTime() : Infinity)));
        if (oldest > range.start.getTime()) cut = true;
      }
    }
    return { runs: all, approximate: cut };
    // runsKey changes whenever any agent's runs arrive.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runsKey, range.start]);

  const error = (agentsQuery.error ?? costQuery.error ?? runQueries.find((query) => query.error)?.error ?? null) as Error | null;

  return {
    agents,
    runs,
    costRows: costQuery.data ?? [],
    isLoading: agentsQuery.isLoading || runQueries.some((query) => query.isLoading) || costQuery.isLoading,
    error,
    approximate,
  };
}
