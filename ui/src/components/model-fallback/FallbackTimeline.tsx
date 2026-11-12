import type { AgentModelFallbackView } from "@paperclipai/shared";
import { connectionLabel, formatClock } from "@/lib/model-fallback/format";
import { strings } from "@/lib/model-fallback/strings";
import { modelBadgeFor } from "@/lib/office/model-badge";

type TimelineEvent = AgentModelFallbackView["timeline"][number];
type Connections = AgentModelFallbackView["connections"];

function modelText(connections: Connections, model: string | null | undefined): string {
  if (!model) return strings.stats.none;
  const match = connections.find((connection) => connection.model === model);
  return match ? connectionLabel(match.adapterType, match.model) : modelBadgeFor("", model).label;
}

function withTask(text: string, event: TimelineEvent): string {
  return event.issueIdentifier ? `${text} · ${strings.timeline.task(event.issueIdentifier)}` : text;
}

function eventText(event: TimelineEvent, connections: Connections): string {
  switch (event.kind) {
    case "switched":
      return withTask(strings.timeline.switched(modelText(connections, event.fromModel), modelText(connections, event.toModel)), event);
    case "returned":
      return withTask(strings.timeline.returned(modelText(connections, event.toModel)), event);
    case "default_changed":
      return strings.timeline.defaultChanged(modelText(connections, event.fromModel), modelText(connections, event.toModel));
    default: {
      const base = event.issueIdentifier
        ? strings.timeline.run(event.issueIdentifier, modelText(connections, event.model))
        : strings.timeline.runNoIssue(modelText(connections, event.model));
      const result = event.status ? (strings.timeline.status[event.status] ?? event.status) : null;
      return result ? `${base} · ${result}` : base;
    }
  }
}

/** Newest-first list of runs and fallback switches. */
export function FallbackTimeline({ events, connections }: { events: TimelineEvent[]; connections: Connections }) {
  const sorted = [...events].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
  return (
    <section aria-label={strings.timeline.title} className="rounded-lg border bg-card/50 p-4">
      <h3 className="mb-3 text-sm font-medium text-muted-foreground">
        {strings.timeline.title} · {strings.timeline.today}
      </h3>
      {sorted.length === 0 ? (
        <p className="text-xs text-muted-foreground">{strings.timeline.empty}</p>
      ) : (
        <ol className="space-y-3">
          {sorted.map((event, index) => (
            <li key={`${event.at}-${index}`} data-testid="timeline-event" data-kind={event.kind} className="flex gap-2 text-xs">
              <time dateTime={event.at} className="w-10 shrink-0 text-muted-foreground">
                {formatClock(event.at)}
              </time>
              <div className="min-w-0">
                <div className="text-foreground">{eventText(event, connections)}</div>
                {event.resetAt ? (
                  <div className="text-muted-foreground">{strings.timeline.quotaReason(formatClock(event.resetAt))}</div>
                ) : event.reason ? (
                  <div className="text-muted-foreground">{event.reason}</div>
                ) : null}
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
