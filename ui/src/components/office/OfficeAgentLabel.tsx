import { forwardRef } from "react";
import { CircleAlert, ClipboardList, Hourglass, PauseCircle } from "lucide-react";
import type { OfficeAgentView } from "@/lib/office/agent-state";
import { formatElapsed } from "@/lib/office/stats";
import { strings } from "@/lib/office/strings";
import { cn } from "@/lib/utils";
import { ModelBadge } from "./ModelBadge";
import { agentToneClass } from "./tone";

function Bubble({ agent, now }: { agent: OfficeAgentView; now: number }) {
  if (agent.assignedFlashUntil != null && agent.assignedFlashUntil > now) {
    return (
      <span className="inline-flex items-center gap-1 text-foreground">
        <ClipboardList className="size-3" /> {strings.label.newTask}
      </span>
    );
  }
  if (agent.marker === "error") {
    return (
      <span className="inline-flex items-center gap-1 text-(--status-agent-error)">
        <CircleAlert className="size-3" /> {strings.rail.error}
      </span>
    );
  }
  if (agent.group === "attention") {
    return (
      <span className="inline-flex items-center gap-1 text-(--status-agent-paused)">
        <CircleAlert className="size-3" /> {agent.attentionIssue?.identifier ?? strings.label.needsYou}
      </span>
    );
  }
  if (agent.group === "working") {
    const what = agent.statusLine ?? agent.currentIssue?.identifier ?? strings.rail.groupWorking;
    const elapsed = agent.runStartedAt ? ` · ${formatElapsed(now - Date.parse(agent.runStartedAt))}` : "";
    return <span className="block max-w-48 truncate text-foreground">{what}{elapsed}</span>;
  }
  if (agent.marker === "paused") {
    return (
      <span className="inline-flex items-center gap-1 text-muted-foreground">
        <PauseCircle className="size-3" /> {strings.rail.paused}
      </span>
    );
  }
  if (agent.waitingOn) {
    return (
      <span className="inline-flex items-center gap-1 text-muted-foreground">
        <Hourglass className="size-3" /> {strings.rail.waitingOn} {agent.waitingOn}
      </span>
    );
  }
  return null;
}

/** Floating name + model label above a character. Positioned by the stage through `ref` (no React re-render per frame). */
export const OfficeAgentLabel = forwardRef<HTMLButtonElement, {
  agent: OfficeAgentView;
  now: number;
  selected: boolean;
  onSelect(id: string): void;
}>(function OfficeAgentLabel({ agent, now, selected, onSelect }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      data-office-label={agent.id}
      onClick={() => onSelect(agent.id)}
      className={cn(
        "pointer-events-auto absolute left-0 top-0 hidden flex-col items-center gap-0.5 rounded-md border bg-background/90 px-2 py-1 text-xs shadow-sm backdrop-blur-sm",
        selected ? "border-ring" : "border-border",
        agent.muted && "opacity-60",
      )}
    >
      <span className="flex items-center gap-1.5 font-medium text-foreground">
        <span className={cn("size-1.5 rounded-full", agentToneClass(agent))} />
        {agent.name}
      </span>
      <ModelBadge badge={agent.badge} size="xs" isFallback={agent.isFallback} unknown={agent.fallbackUnknown} />
      <Bubble agent={agent} now={now} />
    </button>
  );
});
