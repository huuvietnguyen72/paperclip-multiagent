import type { Issue, IssueBlockerAttention } from "@paperclipai/shared";

export interface RecentTask {
  id: string;
  identifier: string | null;
  title: string;
  status: string;
  assigneeAgentId: string | null;
  updatedAt: string;
  blockerAttention?: IssueBlockerAttention;
}

export const RECENT_TASK_LIMIT = 8;

const toIso = (value: Date | string) => new Date(value).toISOString();

/** The most recently updated, visible tasks, newest first. */
export function recentTasks(issues: Issue[], limit: number = RECENT_TASK_LIMIT): RecentTask[] {
  return issues
    .filter((issue) => issue.hiddenAt == null)
    .map((issue): RecentTask => ({
      id: issue.id,
      identifier: issue.identifier ?? null,
      title: issue.title,
      status: issue.status,
      assigneeAgentId: issue.assigneeAgentId ?? null,
      updatedAt: toIso(issue.updatedAt),
      blockerAttention: issue.blockerAttention,
    }))
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, limit);
}
