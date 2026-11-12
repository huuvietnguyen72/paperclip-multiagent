import type { ReactNode } from "react";
import { Pencil, Star } from "lucide-react";
import type { AgentModelFallbackView } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { ModelBadge } from "@/components/office/ModelBadge";
import { formatClock, formatRemaining } from "@/lib/model-fallback/format";
import { strings } from "@/lib/model-fallback/strings";
import { modelBadgeFor } from "@/lib/office/model-badge";
import { cn } from "@/lib/utils";

export type FallbackConnection = AgentModelFallbackView["connections"][number];

export function isExhausted(connection: FallbackConnection, now: Date): boolean {
  return Boolean(connection.exhaustedUntil) && new Date(connection.exhaustedUntil as string).getTime() > now.getTime();
}

export interface ConnectionCardProps {
  connection: FallbackConnection;
  now: Date;
  /** Extension point: when set, the card shows the edit (pencil) button. */
  onEdit?: (connection: FallbackConnection) => void;
  /** Extension point: when set, non-default cards show "Đặt mặc định". */
  onSetDefault?: (connection: FallbackConnection) => void;
  /** Extension point: drag handle rendered before the position label (reorder). */
  dragHandle?: ReactNode;
  /** True while a save is in flight: the set-default button is disabled. */
  busy?: boolean;
  className?: string;
}

/** One connection of the agent's chain: position, model, state, usage and (when exhausted) quota. */
export function ConnectionCard({ connection, now, onEdit, onSetDefault, dragHandle, busy, className }: ConnectionCardProps) {
  const exhausted = isExhausted(connection, now);
  const badge = modelBadgeFor(connection.adapterType, connection.model);
  const position = connection.isDefault
    ? strings.hub.positionMainDefault(connection.position)
    : strings.hub.positionFallbackN(connection.position);

  return (
    <div
      data-testid={`connection-${connection.id}`}
      data-state={connection.inUse ? "in-use" : exhausted ? "exhausted" : "ready"}
      className={cn(
        "rounded-lg border bg-card p-3 text-card-foreground",
        connection.inUse && "border-(--status-task-in_progress)",
        exhausted && !connection.inUse && "border-(--status-task-todo)",
        className,
      )}
    >
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="flex items-center gap-1 font-medium text-muted-foreground">
          {dragHandle}
          {position}
        </span>
        <span
          className={cn(
            "font-medium",
            connection.inUse && "text-(--status-task-icon-in_progress)",
            exhausted && !connection.inUse && "text-(--status-task-icon-todo)",
            !connection.inUse && !exhausted && "text-muted-foreground",
          )}
        >
          {connection.inUse
            ? strings.hub.stateInUse
            : exhausted
              ? `${strings.hub.stateExhausted(formatRemaining(new Date(connection.exhaustedUntil as string), now))} · ${strings.hub.resetsAt(formatClock(connection.exhaustedUntil as string))}`
              : strings.hub.stateReady}
        </span>
      </div>

      <div className="mt-2 flex items-center justify-between gap-2">
        <ModelBadge badge={badge} className="text-foreground" />
        <div className="flex shrink-0 items-center gap-1">
          {onSetDefault && !connection.isDefault ? (
            <Button type="button" variant="ghost" size="xs" disabled={busy} onClick={() => onSetDefault(connection)}>
              <Star aria-hidden />
              {strings.hub.setDefault}
            </Button>
          ) : null}
          {onEdit ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={strings.editDialog.title(connection.position)}
              onClick={() => onEdit(connection)}
            >
              <Pencil aria-hidden />
            </Button>
          ) : null}
        </div>
      </div>

      {connection.accountLabel ? (
        <div className="mt-1 truncate text-xs text-muted-foreground">{connection.accountLabel}</div>
      ) : null}
      <div className="mt-1 text-xs text-muted-foreground">
        {strings.hub.runsToday(connection.runsToday)} · {strings.stats.tokens(connection.tokensToday.toLocaleString("vi-VN"))}
      </div>

      {exhausted && connection.quotaWindows.length > 0 ? (
        <ul className="mt-2 space-y-1">
          {connection.quotaWindows.map((window) => {
            const percent = Math.max(0, Math.min(100, window.usedPercent ?? 0));
            return (
              <li key={window.label} className="flex items-center gap-2 text-xs text-muted-foreground">
                <span className="w-10 shrink-0">{window.label}</span>
                <span className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                  <span className="absolute inset-y-0 left-0 bg-(--status-task-todo)" style={{ width: `${percent}%` }} />
                </span>
                <span className="w-8 shrink-0 text-right">
                  {window.usedPercent == null ? strings.stats.none : `${Math.round(percent)}%`}
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
