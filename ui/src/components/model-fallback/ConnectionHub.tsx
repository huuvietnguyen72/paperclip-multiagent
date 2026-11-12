import { useEffect, useRef, useState } from "react";
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AdapterMark } from "@/components/AdapterMark";
import { strings } from "@/lib/model-fallback/strings";
import { cardAnchors, curvePath } from "@/lib/model-fallback/hub-geometry";
import { cn } from "@/lib/utils";
import { ConnectionCard, isExhausted, type FallbackConnection } from "./ConnectionCard";

const FALLBACK_SIZE = { width: 80, height: 200 };

export interface ConnectionHubProps {
  agentName: string;
  agentAdapterType: string;
  agentRole?: string;
  /** Identifier of the issue the agent is working on right now. */
  currentIssue?: string | null;
  tokensToday?: number;
  /** Connections in chain order. */
  connections: FallbackConnection[];
  now: Date;
  /** Extension points for the editing dialogs (Task 10). All optional; the hub is read-only without them. */
  onEdit?: (connection: FallbackConnection) => void;
  onSetDefault?: (connection: FallbackConnection) => void;
  onAdd?: () => void;
  /** Called with the whole chain's ids in the new order (drag and drop). Dropping on slot 1 sets the default. */
  onReorder?: (orderedIds: string[]) => void;
  /** True while a save is in flight: set-default, drag and add are disabled. */
  busy?: boolean;
}

function SortableConnection({ connection, now, onEdit, onSetDefault, busy }: Pick<ConnectionHubProps, "onEdit" | "onSetDefault" | "busy"> & { connection: FallbackConnection; now: Date }) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: connection.id, disabled: busy });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, zIndex: isDragging ? 10 : undefined }}
      className={cn(isDragging && "opacity-80")}
    >
      <ConnectionCard
        connection={connection}
        now={now}
        onEdit={onEdit}
        onSetDefault={onSetDefault}
        busy={busy}
        dragHandle={
          <button
            type="button"
            disabled={busy}
            ref={setActivatorNodeRef}
            aria-label={strings.hub.dragHandle(connection.position)}
            className="cursor-grab touch-none rounded-sm text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
            {...attributes}
            {...listeners}
          >
            <GripVertical className="size-4" aria-hidden />
          </button>
        }
      />
    </div>
  );
}

/** Agent card on the left, one card per connection on the right, SVG curves between them (md and up). */
export function ConnectionHub({ agentName, agentAdapterType, agentRole, currentIssue, tokensToday, connections, now, onEdit, onSetDefault, onAdd, onReorder, busy }: ConnectionHubProps) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (busy || !onReorder || !over || active.id === over.id) return;
    const ids = connections.map((connection) => connection.id);
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    onReorder(arrayMove(ids, from, to));
  };
  const spacerRef = useRef<HTMLDivElement>(null);
  const cardsRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState(FALLBACK_SIZE);
  const [anchors, setAnchors] = useState<number[]>([]);

  useEffect(() => {
    const spacer = spacerRef.current;
    const cards = cardsRef.current;
    if (!spacer || !cards) return;
    const measure = () => {
      const width = spacer.clientWidth || FALLBACK_SIZE.width;
      const height = spacer.clientHeight || FALLBACK_SIZE.height;
      setSize((previous) => (previous.width === width && previous.height === height ? previous : { width, height }));
      const next = cardAnchors(
        spacer.getBoundingClientRect(),
        [...cards.children].map((child) => child.getBoundingClientRect()),
      );
      setAnchors((previous) =>
        previous.length === next.length && previous.every((y, index) => y === next[index]) ? previous : next,
      );
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(spacer);
    observer.observe(cards);
    return () => observer.disconnect();
  }, [connections.length]);

  const startY = size.height / 2;

  return (
    <section aria-label={strings.hub.title} className="rounded-lg border bg-card/50 p-4">
      <h3 className="mb-3 text-sm font-medium text-muted-foreground">{strings.hub.title}</h3>
      <div className="flex flex-col gap-3 md:flex-row md:items-stretch md:gap-0">
        <div className="flex md:items-center">
          <div data-testid="agent-card" className="flex w-full items-center gap-2 rounded-lg border bg-card p-3 md:w-44">
            <AdapterMark type={agentAdapterType} className="size-5 shrink-0" />
            <div className="min-w-0">
              <div className="truncate text-sm font-medium text-foreground">{agentName}</div>
              <div className="truncate text-xs text-muted-foreground">{agentRole ?? strings.hub.agent}</div>
              {currentIssue ? <div className="truncate text-xs text-foreground">{strings.timeline.task(currentIssue)}</div> : null}
              {tokensToday != null ? (
                <div className="truncate text-xs text-muted-foreground">{strings.hub.agentTokens(tokensToday.toLocaleString("vi-VN"))}</div>
              ) : null}
            </div>
          </div>
        </div>

        <div ref={spacerRef} className="relative hidden w-20 shrink-0 md:block" aria-hidden>
          <svg className="absolute inset-0 size-full" viewBox={`0 0 ${size.width} ${size.height}`} preserveAspectRatio="none" fill="none">
            {connections.map((connection, index) => {
              const endY = anchors[index] ?? ((index + 0.5) / connections.length) * size.height;
              const d = curvePath({ x: 0, y: startY }, { x: size.width, y: endY });
              const exhausted = isExhausted(connection, now);
              return (
                <path
                  key={connection.id}
                  d={d}
                  data-line={connection.inUse ? "in-use" : exhausted ? "exhausted" : "idle"}
                  strokeLinecap="round"
                  className={cn(
                    connection.inUse && "mf-line-flow stroke-(color:--status-task-in_progress)",
                    !connection.inUse && exhausted && "stroke-(color:--status-task-todo)",
                    !connection.inUse && !exhausted && "stroke-muted-foreground opacity-40",
                  )}
                  strokeWidth={connection.inUse ? 3 : exhausted ? 2 : 1.5}
                  strokeDasharray={!connection.inUse && exhausted ? "2 6" : undefined}
                />
              );
            })}
          </svg>
        </div>

        <div ref={cardsRef} className="relative flex min-w-0 flex-1 flex-col gap-3">
          {onReorder ? (
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
              <SortableContext items={connections.map((connection) => connection.id)} strategy={verticalListSortingStrategy}>
                {connections.map((connection) => (
                  <SortableConnection key={connection.id} connection={connection} now={now} onEdit={onEdit} onSetDefault={onSetDefault} busy={busy} />
                ))}
              </SortableContext>
            </DndContext>
          ) : (
            connections.map((connection) => (
              <ConnectionCard key={connection.id} connection={connection} now={now} onEdit={onEdit} onSetDefault={onSetDefault} busy={busy} />
            ))
          )}
        </div>
      </div>
      {onAdd ? (
        <div className="mt-3 flex justify-end">
          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={onAdd}>
            {strings.hub.addAccount}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
