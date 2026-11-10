import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import type { LiveEvent } from "@paperclipai/shared";
import { agentsApi } from "@/api/agents";
import { approvalsApi } from "@/api/approvals";
import { costsApi } from "@/api/costs";
import { heartbeatsApi } from "@/api/heartbeats";
import { issuesApi } from "@/api/issues";
import { useCompanyLiveEvent } from "@/context/LiveUpdatesProvider";
import { deriveOfficeAgents, type OfficeAgentView } from "@/lib/office/agent-state";
import { feedItemFromLiveEvent, pushFeedItem, type FeedItem } from "@/lib/office/activity-feed";
import { invalidationTargets } from "@/lib/office/live-invalidation";
import { aggregateOfficeStats, utcMonthStart, type OfficeStats } from "@/lib/office/stats";

export interface OfficeData {
  agents: OfficeAgentView[];
  stats: OfficeStats;
  feed: FeedItem[];
  isLoading: boolean;
  error: Error | null;
  now: number;
}

const FAST_REFRESH_MS = 15_000;
/** Server maximum page size for heartbeat runs. */
const RUNS_LIMIT = 1000;
const SLOW_REFRESH_MS = 60_000;

const officeKey = (companyId: string, part: string) => ["office", companyId, part] as const;

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

export function useOfficeData(companyId: string): OfficeData {
  const queryClient = useQueryClient();
  const now = useNow(1000);
  // The month only changes at a boundary, so key cost queries on the month start, not on every tick.
  const monthStartIso = utcMonthStart(new Date(now)).toISOString();

  const agentsQuery = useQuery({
    queryKey: officeKey(companyId, "agents"),
    queryFn: () => agentsApi.list(companyId),
    refetchInterval: SLOW_REFRESH_MS,
  });
  const liveRunsQuery = useQuery({
    queryKey: officeKey(companyId, "liveRuns"),
    queryFn: () => heartbeatsApi.liveRunsForCompany(companyId),
    refetchInterval: FAST_REFRESH_MS,
  });
  const issuesQuery = useQuery({
    queryKey: officeKey(companyId, "issues"),
    queryFn: () => issuesApi.listAll(companyId, {}),
    refetchInterval: SLOW_REFRESH_MS,
  });
  const approvalsQuery = useQuery({
    queryKey: officeKey(companyId, "approvals"),
    queryFn: () => approvalsApi.list(companyId, "pending"),
    refetchInterval: SLOW_REFRESH_MS,
  });
  const runsQuery = useQuery({
    queryKey: officeKey(companyId, "runs"),
    // Summary rows carry agentId/startedAt/finishedAt, all the runtime tile needs, at a fraction of the size.
    queryFn: () => heartbeatsApi.list(companyId, undefined, RUNS_LIMIT, { summary: true }),
    refetchInterval: SLOW_REFRESH_MS,
  });
  const costSummaryQuery = useQuery({
    queryKey: [...officeKey(companyId, "costSummary"), monthStartIso],
    queryFn: () => costsApi.summary(companyId, monthStartIso),
    refetchInterval: SLOW_REFRESH_MS,
  });
  const costByAgentQuery = useQuery({
    queryKey: [...officeKey(companyId, "costByAgent"), monthStartIso],
    queryFn: () => costsApi.byAgent(companyId, monthStartIso),
    refetchInterval: SLOW_REFRESH_MS,
  });

  const adapterTypes = useMemo(
    () => Array.from(new Set((agentsQuery.data ?? []).map((agent) => agent.adapterType))).sort(),
    [agentsQuery.data],
  );
  const adapterModelQueries = useQueries({
    queries: adapterTypes.map((type) => ({
      queryKey: [...officeKey(companyId, "adapterModels"), type],
      queryFn: () => agentsApi.adapterModels(companyId, type),
      staleTime: Infinity,
      retry: false,
    })),
  });
  const adapterLabelsKey = adapterModelQueries.map((query) => query.dataUpdatedAt).join(",");
  const adapterLabels = useMemo(() => {
    const labels = new Map<string, ReadonlyMap<string, string>>();
    adapterTypes.forEach((type, index) => {
      const models = adapterModelQueries[index]?.data;
      if (Array.isArray(models)) labels.set(type, new Map(models.map((model) => [model.id, model.label])));
    });
    return labels;
    // adapterLabelsKey changes whenever any adapter model list arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adapterTypes, adapterLabelsKey]);

  const recentCommentAt = useRef(new Map<string, number>());
  const recentAssignedAt = useRef(new Map<string, number>());
  const [feed, setFeed] = useState<FeedItem[]>([]);

  const agentsData = agentsQuery.data;
  const issuesData = issuesQuery.data;
  const feedContext = useMemo(() => {
    const agentNames = new Map((agentsData ?? []).map((agent) => [agent.id, agent.name]));
    const identifiers = new Map((issuesData ?? []).map((issue) => [issue.id, issue.identifier ?? null]));
    return {
      agentName: (id: string) => agentNames.get(id) ?? null,
      issueIdentifier: (id: string) => identifiers.get(id) ?? null,
    };
  }, [agentsData, issuesData]);

  const invalidate = useCallback(
    (...parts: string[]) => {
      for (const part of parts) void queryClient.invalidateQueries({ queryKey: officeKey(companyId, part) });
    },
    [companyId, queryClient],
  );

  useCompanyLiveEvent((event: LiveEvent) => {
    if (event.companyId !== companyId) return;
    const payload = event.payload ?? {};

    invalidate(...invalidationTargets(event));
    if (event.type === "activity.logged") {
      const action = String(payload.action ?? "");
      if (action === "issue.comment_added" && payload.actorType === "agent") {
        const agentId = (payload.agentId ?? payload.actorId) as string | null;
        if (agentId) recentCommentAt.current.set(agentId, Date.now());
      }
      if (action === "issue.created" || action === "issue.updated") {
        const details = (payload.details ?? {}) as Record<string, unknown>;
        if (typeof details.assigneeAgentId === "string") recentAssignedAt.current.set(details.assigneeAgentId, Date.now());
      }
    }

    const item = feedItemFromLiveEvent(event, feedContext);
    if (item) setFeed((list) => pushFeedItem(list, item));
  });

  const agents = useMemo(
    () =>
      deriveOfficeAgents({
        agents: agentsQuery.data ?? [],
        liveRuns: liveRunsQuery.data ?? [],
        issues: issuesQuery.data ?? [],
        pendingApprovals: approvalsQuery.data ?? [],
        recentCommentAt: recentCommentAt.current,
        recentAssignedAt: recentAssignedAt.current,
        adapterLabels,
        now,
      }),
    [agentsQuery.data, liveRunsQuery.data, issuesQuery.data, approvalsQuery.data, adapterLabels, now],
  );

  const stats = useMemo(
    () =>
      aggregateOfficeStats({
        agents,
        issues: issuesQuery.data ?? [],
        runs: runsQuery.data ?? [],
        costSummary: costSummaryQuery.data ?? null,
        costByAgent: costByAgentQuery.data ?? [],
        now: new Date(now),
        runsLimit: RUNS_LIMIT,
      }),
    [agents, issuesQuery.data, runsQuery.data, costSummaryQuery.data, costByAgentQuery.data, now],
  );

  const error = (agentsQuery.error ?? liveRunsQuery.error ?? issuesQuery.error ?? null) as Error | null;

  return {
    agents,
    stats,
    feed,
    isLoading: agentsQuery.isLoading,
    error,
    now,
  };
}
