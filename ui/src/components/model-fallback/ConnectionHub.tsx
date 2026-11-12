import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { AdapterMark } from "@/components/AdapterMark";
import { strings } from "@/lib/model-fallback/strings";
import { cn } from "@/lib/utils";
import { ConnectionCard, isExhausted, type FallbackConnection } from "./ConnectionCard";

const FALLBACK_SIZE = { width: 80, height: 200 };

export interface ConnectionHubProps {
  agentName: string;
  agentAdapterType: string;
  /** Connections in chain order. */
  connections: FallbackConnection[];
  now: Date;
  /** Extension points for the editing dialogs (Task 10). All optional; the hub is read-only without them. */
  onEdit?: (connection: FallbackConnection) => void;
  onSetDefault?: (connection: FallbackConnection) => void;
  onAdd?: () => void;
}

/** Agent card on the left, one card per connection on the right, SVG curves between them (md and up). */
export function ConnectionHub({ agentName, agentAdapterType, connections, now, onEdit, onSetDefault, onAdd }: ConnectionHubProps) {
  const spacerRef = useRef<HTMLDivElement>(null);
  const cardsRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState(FALLBACK_SIZE);
  const [anchors, setAnchors] = useState<number[]>([]);

  const fallbackNumbers = new Map<string, number>();
  connections.filter((connection) => !connection.isDefault).forEach((connection, index) => fallbackNumbers.set(connection.id, index + 1));

  useEffect(() => {
    const spacer = spacerRef.current;
    const cards = cardsRef.current;
    if (!spacer || !cards) return;
    const measure = () => {
      const width = spacer.clientWidth || FALLBACK_SIZE.width;
      const height = spacer.clientHeight || FALLBACK_SIZE.height;
      setSize((previous) => (previous.width === width && previous.height === height ? previous : { width, height }));
      const next = [...cards.children].map((child) => {
        const element = child as HTMLElement;
        return element.offsetTop + element.offsetHeight / 2;
      });
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
  const midX = size.width / 2;

  return (
    <section aria-label={strings.hub.title} className="rounded-lg border bg-card/50 p-4">
      <h3 className="mb-3 text-sm font-medium text-muted-foreground">{strings.hub.title}</h3>
      <div className="flex flex-col gap-3 md:flex-row md:items-stretch md:gap-0">
        <div className="flex md:items-center">
          <div data-testid="agent-card" className="flex w-full items-center gap-2 rounded-lg border bg-card p-3 md:w-44">
            <AdapterMark type={agentAdapterType} className="size-5 shrink-0" />
            <div className="min-w-0">
              <div className="truncate text-sm font-medium text-foreground">{agentName}</div>
              <div className="text-xs text-muted-foreground">{strings.hub.agent}</div>
            </div>
          </div>
        </div>

        <div ref={spacerRef} className="relative hidden w-20 shrink-0 md:block" aria-hidden>
          <svg className="absolute inset-0 size-full overflow-visible" width={size.width} height={size.height} fill="none">
            {connections.map((connection, index) => {
              const endY = anchors[index] ?? ((index + 0.5) / connections.length) * size.height;
              const d = `M0 ${startY} C${midX} ${startY} ${midX} ${endY} ${size.width} ${endY}`;
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

        <div ref={cardsRef} className="flex min-w-0 flex-1 flex-col gap-3">
          {connections.map((connection) => (
            <ConnectionCard
              key={connection.id}
              connection={connection}
              fallbackNumber={fallbackNumbers.get(connection.id) ?? null}
              now={now}
              onEdit={onEdit}
              onSetDefault={onSetDefault}
            />
          ))}
        </div>
      </div>
      {onAdd ? (
        <div className="mt-3 flex justify-end">
          <Button type="button" variant="outline" size="sm" onClick={onAdd}>
            {strings.hub.addAccount}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
