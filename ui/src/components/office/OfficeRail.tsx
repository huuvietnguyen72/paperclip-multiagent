import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";
import type { OfficeAgentView, OfficeGroup } from "@/lib/office/agent-state";
import { formatAgo, formatElapsed, type OfficeStats } from "@/lib/office/stats";
import { strings } from "@/lib/office/strings";
import { cn } from "@/lib/utils";
import { ModelBadge } from "./ModelBadge";
import { agentToneClass } from "./tone";

const GROUPS: ReadonlyArray<{ id: OfficeGroup; title: string }> = [
  { id: "attention", title: strings.rail.groupAttention },
  { id: "working", title: strings.rail.groupWorking },
  { id: "idle", title: strings.rail.groupIdle },
];

function statusText(agent: OfficeAgentView, now: number): string {
  if (agent.group === "working") {
    const issue = agent.currentIssue?.identifier;
    return [issue, agent.statusLine].filter(Boolean).join(" · ") || strings.rail.groupWorking;
  }
  if (agent.group === "attention") {
    const reason = agent.marker === "error" ? strings.rail.error : (agent.attentionIssue?.identifier ?? strings.rail.groupAttention);
    return agent.hasLiveRun && agent.statusLine ? `${reason} · ${agent.statusLine}` : reason;
  }
  const parts: string[] = [];
  if (agent.marker === "paused") parts.push(strings.rail.paused);
  if (agent.waitingOn) parts.push(`${strings.rail.waitingOn} ${agent.waitingOn}`);
  parts.push(agent.lastHeartbeatAt
    ? `${strings.rail.lastSeen} ${formatAgo(now - Date.parse(agent.lastHeartbeatAt))}`
    : strings.rail.never);
  return parts.join(" · ");
}

function AgentCard({ agent, now, selected, onSelect, onAssign }: {
  agent: OfficeAgentView;
  now: number;
  selected: boolean;
  onSelect(id: string | null): void;
  onAssign(id: string | null): void;
}) {
  // The issue that needs the owner comes first; otherwise the one the agent is working on.
  const issueLink = agent.attentionIssue ?? agent.currentIssue;
  return (
    <div
      data-agent-card={agent.id}
      data-selected={selected ? "true" : "false"}
      className={cn(
        "rounded-lg border border-border/60 bg-background/60 text-sm transition-colors",
        selected && "border-ring bg-accent",
        agent.muted && "opacity-60",
      )}
    >
      <button
        type="button"
        data-select
        onClick={() => onSelect(selected ? null : agent.id)}
        className="flex w-full min-w-0 flex-col gap-0.5 px-2.5 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="flex min-w-0 items-center gap-2">
          <span className={cn("size-2 shrink-0 rounded-full", agentToneClass(agent))} />
          <span className="truncate font-medium text-foreground">{agent.name}</span>
          {agent.hasLiveRun && agent.runStartedAt ? (
            <span className="ml-auto shrink-0 font-mono text-xs text-foreground">
              {formatElapsed(now - Date.parse(agent.runStartedAt))}
            </span>
          ) : null}
        </span>
        <ModelBadge badge={agent.badge} size="xs" className="pl-4" />
        <span className="truncate pl-4 text-xs text-muted-foreground">{statusText(agent, now)}</span>
      </button>
      {selected ? (
        <div className="flex flex-wrap items-center gap-2 border-t border-border/60 px-2.5 py-2 text-xs">
          <Button size="xs" data-assign onClick={() => onAssign(agent.id)}>
            {strings.assignWork}
          </Button>
          {issueLink?.identifier ? (
            <Link to={`/issues/${issueLink.identifier}`} className="text-muted-foreground hover:text-foreground hover:underline">
              {strings.rail.openIssue} {issueLink.identifier}
            </Link>
          ) : null}
          <Link to={`/agents/${agent.urlKey || agent.id}`} className="text-muted-foreground hover:text-foreground hover:underline">
            {strings.rail.openAgent}
          </Link>
        </div>
      ) : null}
    </div>
  );
}

export function OfficeRail({ agents, stats, now, selectedId, onSelect, onAssign }: {
  agents: OfficeAgentView[];
  stats: OfficeStats;
  now: number;
  selectedId: string | null;
  onSelect(id: string | null): void;
  onAssign(id: string | null): void;
}) {
  const counts = {
    working: agents.filter((agent) => agent.hasLiveRun).length,
    waiting: agents.filter((agent) => agent.group === "attention").length,
    idle: agents.filter((agent) => agent.group === "idle").length,
  };
  return (
    <aside className="flex min-h-0 flex-col gap-3 overflow-y-auto p-3">
      <div>
        <h2 className="text-sm font-semibold text-foreground">{strings.rail.title}</h2>
        <p className="text-xs text-muted-foreground">{strings.rail.agentCount(stats.company.shownCount)}</p>
      </div>
      <div className="grid grid-cols-3 gap-1.5 text-xs text-muted-foreground">
        {([
          ["working", counts.working, strings.rail.working],
          ["waiting", counts.waiting, strings.rail.waiting],
          ["idle", counts.idle, strings.rail.idle],
        ] as const).map(([key, value, label]) => (
          <div key={key} data-office-count={key} className="rounded-md border border-border/60 bg-background/60 px-2 py-1.5">
            <span className="block text-base font-semibold text-foreground">{value}</span>
            {label}
          </div>
        ))}
      </div>
      {GROUPS.map((group) => {
        const members = agents.filter((agent) => agent.group === group.id);
        if (members.length === 0) return null;
        return (
          <section key={group.id} data-office-group={group.id} className="flex flex-col gap-1.5">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {group.title} · {members.length}
            </h3>
            {members.map((agent) => (
              <AgentCard
                key={agent.id}
                agent={agent}
                now={now}
                selected={agent.id === selectedId}
                onSelect={onSelect}
                onAssign={onAssign}
              />
            ))}
          </section>
        );
      })}
    </aside>
  );
}
