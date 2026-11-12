import { useQuery } from "@tanstack/react-query";
import type { Agent, AgentModelFallbackView } from "@paperclipai/shared";
import { modelFallbackApi } from "@/api/model-fallback";
import { Button } from "@/components/ui/button";
import { connectionLabel, formatClock, formatElapsed } from "@/lib/model-fallback/format";
import { strings } from "@/lib/model-fallback/strings";
import { cn } from "@/lib/utils";
import { queryKeys } from "@/lib/queryKeys";
import { isExhausted, type FallbackConnection } from "./ConnectionCard";
import { ConnectionHub } from "./ConnectionHub";
import { FallbackTimeline } from "./FallbackTimeline";

const REFRESH_MS = 15_000;
const REFRESH_IN_USE_MS = 5_000;

export interface ModelFallbackTabProps {
  agent: Agent;
  companyId: string;
  /** Extension points for the editing dialogs (Task 10). */
  onOpenSettings?: () => void;
  onEditConnection?: (connection: FallbackConnection) => void;
  onSetDefault?: (connection: FallbackConnection) => void;
  onAddConnection?: () => void;
}

/** Connection the header chip shows: among in-use connections, the one whose latest run started most recently. */
export function pickLiveConnection(connections: FallbackConnection[]): FallbackConnection | null {
  const live = connections.filter((connection) => connection.inUse);
  if (live.length === 0) return null;
  const startedAt = (connection: FallbackConnection) => (connection.lastUsedAt ? new Date(connection.lastUsedAt).getTime() : 0);
  return live.reduce((best, connection) => (startedAt(connection) > startedAt(best) ? connection : best));
}

function Tile({ label, value, hint, title }: { label: string; value: string; hint?: string; title?: string }) {
  return (
    <div className="min-w-0 rounded-lg border bg-card p-3" title={title}>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 truncate text-sm font-medium text-foreground">{value}</div>
      {hint ? <div className="mt-0.5 truncate text-xs text-muted-foreground">{hint}</div> : null}
    </div>
  );
}

function Body({ agent, view, now, props }: { agent: Agent; view: AgentModelFallbackView; now: Date; props: ModelFallbackTabProps }) {
  const connections = [...view.connections].sort((a, b) => a.position - b.position);
  const live = pickLiveConnection(connections);
  const liveCount = connections.filter((connection) => connection.inUse).length;
  const fallbackNumber = live && !live.isDefault ? connections.filter((c) => !c.isDefault && c.position <= live.position).length : null;
  const defaultConnection = connections.find((connection) => connection.isDefault) ?? null;
  const defaultExhausted = defaultConnection ? isExhausted(defaultConnection, now) : false;
  const runningRun = [...view.timeline]
    .filter((event) => event.kind === "run" && (event.status === "running" || event.status === "queued"))
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())[0] ?? null;
  const isRunning = runningRun !== null;
  const unfinished = view.pinnedIssues.filter((issue) => !issue.finished);
  const currentTask = unfinished[0] ?? null;
  const currentIssue = runningRun?.issueIdentifier ?? null;
  const defaultLabel = defaultConnection ? connectionLabel(defaultConnection.adapterType, defaultConnection.model) : strings.stats.none;
  const resetClock = defaultConnection?.exhaustedUntil ? formatClock(defaultConnection.exhaustedUntil) : "";

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="truncate text-lg font-semibold text-foreground">{agent.name}</h2>
            {live ? (
              <span
                data-testid="live-chip"
                className="inline-flex items-center gap-1.5 rounded-full border border-(--status-task-in_progress) px-2 py-0.5 text-xs text-foreground"
              >
                <span
                  aria-hidden
                  data-pulse={isRunning ? "true" : "false"}
                  className={cn("size-1.5 rounded-full bg-(--status-task-in_progress)", isRunning && "motion-safe:animate-pulse")}
                />
                <span>{isRunning ? strings.header.running : strings.header.inUse}</span>
                <span>{connectionLabel(live.adapterType, live.model)}</span>
                {liveCount > 1 ? <span className="text-muted-foreground">{strings.header.more(liveCount - 1)}</span> : null}
              </span>
            ) : null}
            {live && !live.isDefault ? (
              <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                {strings.header.fallbackTag(fallbackNumber ?? live.position - 1)}
              </span>
            ) : null}
          </div>
          {defaultConnection && defaultExhausted && !defaultConnection.inUse ? (
            <p className="text-xs text-muted-foreground">{strings.header.reason(defaultLabel, resetClock)}</p>
          ) : null}
        </div>
        <Button type="button" variant="outline" size="sm" disabled={!props.onOpenSettings} onClick={props.onOpenSettings}>
          {strings.header.settings}
        </Button>
      </header>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile
          label={strings.stats.inUse}
          value={live ? connectionLabel(live.adapterType, live.model) : strings.stats.none}
          hint={live?.lastUsedAt ? formatClock(live.lastUsedAt) : undefined}
        />
        <Tile
          label={strings.stats.currentTask}
          value={currentIssue ?? currentTask?.identifier ?? strings.stats.none}
          hint={
            runningRun
              ? strings.stats.elapsed(formatElapsed(runningRun.at, now))
              : currentTask?.title
          }
          title={currentTask?.title}
        />
        <Tile
          label={strings.stats.switchesToday}
          value={String(view.today.switches)}
          hint={strings.stats.tokens(view.today.tokens.toLocaleString("vi-VN"))}
        />
        <Tile
          label={strings.stats.default}
          value={defaultLabel}
          hint={
            defaultExhausted
              ? strings.stats.returnWhen(unfinished.map((issue) => issue.identifier).join(", ") || strings.stats.none, resetClock)
              : strings.hub.stateReady
          }
        />
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <div className="min-w-0 md:col-span-2">
          <ConnectionHub
            agentName={agent.name}
            agentAdapterType={agent.adapterType}
            agentRole={agent.role}
            currentIssue={currentIssue}
            tokensToday={view.today.tokens}
            connections={connections}
            now={now}
            onEdit={props.onEditConnection}
            onSetDefault={props.onSetDefault}
            onAdd={props.onAddConnection}
          />
        </div>
        <FallbackTimeline events={view.timeline} connections={connections} />
      </div>
    </div>
  );
}

/** Agent tab "Kết nối model": live view of the agent's connection chain and fallback history. */
export function ModelFallbackTab(props: ModelFallbackTabProps) {
  const { agent, companyId } = props;
  const query = useQuery({
    queryKey: [...queryKeys.modelFallback.agent(agent.id), companyId],
    queryFn: () => modelFallbackApi.agentView(agent.id, companyId),
    refetchInterval: (q) => (q.state.data?.connections.some((connection) => connection.inUse) ? REFRESH_IN_USE_MS : REFRESH_MS),
  });

  if (query.isLoading) return <p className="text-sm text-muted-foreground">{strings.states.loading}</p>;
  if (query.error || !query.data) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {strings.states.loadFailed}
      </p>
    );
  }
  return <Body agent={agent} view={query.data} now={new Date(query.dataUpdatedAt || Date.now())} props={props} />;
}
