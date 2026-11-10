import { Link } from "@/lib/router";
import { StatusIcon } from "@/components/StatusIcon";
import type { RecentTask } from "@/lib/office/recent-tasks";
import { formatAgo } from "@/lib/office/stats";
import { strings } from "@/lib/office/strings";

/** Recently updated tasks of the company, or of the selected agent. */
export function OfficeRecentTasks({ tasks, isLoading, agentName, selectedName, now }: {
  tasks: RecentTask[];
  isLoading: boolean;
  agentName(id: string): string | null;
  selectedName: string | null;
  now: number;
}) {
  return (
    <section data-recent-tasks className="flex flex-col gap-1.5">
      <h2 className="text-sm font-semibold text-foreground">
        {selectedName ? strings.recent.titleFor(selectedName) : strings.recent.title}
      </h2>
      {tasks.length === 0 ? (
        <p className="text-xs text-muted-foreground">{isLoading ? strings.loading : strings.recent.empty}</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {tasks.map((task) => {
            const who = task.assigneeAgentId ? (agentName(task.assigneeAgentId) ?? "—") : strings.recent.unassigned;
            const body = (
              <span className="flex min-w-0 items-start gap-2 rounded-md border border-border/60 bg-background/60 px-2.5 py-1.5 text-xs hover:bg-accent">
                <StatusIcon status={task.status} blockerAttention={task.blockerAttention} size="sm" className="mt-0.5 shrink-0" />
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="flex min-w-0 gap-1.5 text-foreground">
                    {task.identifier ? <span className="shrink-0 font-mono text-muted-foreground">{task.identifier}</span> : null}
                    <span className="truncate">{task.title}</span>
                  </span>
                  <span className="truncate text-muted-foreground">
                    {who} · {formatAgo(now - Date.parse(task.updatedAt))}
                  </span>
                </span>
              </span>
            );
            return (
              <li key={task.id}>
                {task.identifier ? <Link to={`/issues/${task.identifier}`}>{body}</Link> : body}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
