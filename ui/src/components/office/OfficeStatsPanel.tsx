import type { ReactNode } from "react";
import type { OfficeAgentView } from "@/lib/office/agent-state";
import { filterFeed, type FeedFilter, type FeedItem } from "@/lib/office/activity-feed";
import { formatDuration, formatSpend, formatTokens, type OfficeStats, type StatBlock } from "@/lib/office/stats";
import { strings } from "@/lib/office/strings";
import { cn } from "@/lib/utils";
import { feedToneClass } from "./tone";

const FILTERS: ReadonlyArray<{ id: FeedFilter; label: string }> = [
  { id: "all", label: strings.feed.all },
  { id: "attention", label: strings.feed.attention },
  { id: "runs", label: strings.feed.runs },
  { id: "comments", label: strings.feed.comments },
];

function Tile({ id, value, sub, label }: { id: string; value: string; sub?: string; label: string }) {
  return (
    <div data-stat={id} className="rounded-md border border-border/60 bg-background/60 px-2.5 py-2">
      <span className="block text-base font-semibold text-foreground">{value}</span>
      {sub ? <span className="block text-xs text-muted-foreground">{sub}</span> : null}
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  );
}

function StatTiles({ block, working, runtimeApproximate = false }: {
  block: StatBlock;
  working?: { count: number; total: number };
  runtimeApproximate?: boolean;
}) {
  return (
    <div className="grid grid-cols-2 gap-1.5">
      <Tile id="done" value={String(block.doneCount)} label={strings.stats.done} />
      <Tile id="cost" value={`${formatTokens(block.tokens)} ${strings.stats.tokenUnit}`} sub={formatSpend(block.spendCents)} label={strings.stats.cost} />
      <Tile id="runtime" value={`${runtimeApproximate ? "≈ " : ""}${formatDuration(block.runtimeMs)}`} label={strings.stats.runtime} />
      {working ? <Tile id="working" value={`${working.count} / ${working.total}`} label={strings.stats.working} /> : null}
    </div>
  );
}

const timeOf = (iso: string) => new Date(iso).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" });

export function OfficeStatsPanel({ stats, feed, filter, onFilter, selectedAgent, agentName, onSelectAgent, recentTasks }: {
  /** Rendered between the stat tiles and the activity feed. */
  recentTasks?: ReactNode;
  stats: OfficeStats;
  feed: FeedItem[];
  filter: FeedFilter;
  onFilter(filter: FeedFilter): void;
  selectedAgent: OfficeAgentView | null;
  agentName(id: string): string | null;
  onSelectAgent(id: string): void;
}) {
  const visible = filterFeed(feed, filter);
  const attentionCount = filterFeed(feed, "attention").length;
  const selectedBlock = selectedAgent ? stats.byAgent.get(selectedAgent.id) : undefined;
  return (
    <aside className="flex min-h-0 flex-col gap-3 overflow-y-auto p-3">
      <div>
        <h2 className="text-sm font-semibold text-foreground">{strings.stats.title}</h2>
        <p className="text-xs text-muted-foreground">{strings.stats.subtitle}</p>
      </div>
      <StatTiles
        block={stats.company}
        working={{ count: stats.company.workingCount, total: stats.company.shownCount }}
        runtimeApproximate={stats.company.runtimeApproximate}
      />
      {selectedAgent && selectedBlock ? (
        <section className="flex flex-col gap-1.5">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {strings.stats.selectedTitle(selectedAgent.name)}
          </h3>
          <StatTiles block={selectedBlock} />
        </section>
      ) : null}
      {recentTasks}
      <section className="flex min-h-0 flex-col gap-2">
        <h2 className="text-sm font-semibold text-foreground">{strings.feed.title}</h2>
        <div className="flex flex-wrap gap-1.5">
          {FILTERS.map((option) => (
            <button
              key={option.id}
              type="button"
              data-feed-filter={option.id}
              onClick={() => onFilter(option.id)}
              className={cn(
                "rounded-full border border-border px-2.5 py-0.5 text-xs text-muted-foreground hover:text-foreground",
                filter === option.id && "border-ring bg-accent text-foreground",
              )}
            >
              {option.label}
              {option.id === "attention" && attentionCount > 0 ? ` ${attentionCount}` : ""}
            </button>
          ))}
        </div>
        {visible.length === 0 ? (
          <p className="text-xs text-muted-foreground">{strings.feed.empty}</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {visible.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  disabled={!item.agentId}
                  onClick={() => item.agentId && onSelectAgent(item.agentId)}
                  className={cn(
                    "flex w-full flex-col gap-0.5 rounded-md border border-l-4 border-border/60 bg-background/60 px-2.5 py-1.5 text-left text-xs",
                    feedToneClass(item.tone),
                  )}
                >
                  <span className="flex items-center justify-between gap-2 font-medium text-foreground">
                    <span className="truncate">{(item.agentId && agentName(item.agentId)) || "—"}</span>
                    <span className="shrink-0 font-normal text-muted-foreground">{timeOf(item.at)}</span>
                  </span>
                  <span className="text-muted-foreground">{item.text}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </aside>
  );
}
