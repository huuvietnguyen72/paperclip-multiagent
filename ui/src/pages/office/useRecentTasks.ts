import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { issuesApi } from "@/api/issues";
import { RECENT_TASK_LIMIT, recentTasks, type RecentTask } from "@/lib/office/recent-tasks";

const SLOW_REFRESH_MS = 60_000;

/**
 * Recently updated tasks: the whole company's when no agent is selected, otherwise the tasks the agent took
 * part in (assigned, commented, ran). The key sits under the office "issues" prefix, so issue activity
 * refreshes it together with the rest of the page.
 */
export function useRecentTasks(companyId: string, agentId: string | null): { tasks: RecentTask[]; isLoading: boolean } {
  const query = useQuery({
    queryKey: ["office", companyId, "issues", "recent", agentId ?? "all"],
    queryFn: () =>
      issuesApi.list(companyId, {
        ...(agentId ? { participantAgentId: agentId } : {}),
        sortField: "updated",
        sortDir: "desc",
        limit: RECENT_TASK_LIMIT * 2,
      }),
    refetchInterval: SLOW_REFRESH_MS,
  });
  const tasks = useMemo(() => recentTasks(query.data ?? []), [query.data]);
  return { tasks, isLoading: query.isLoading };
}
