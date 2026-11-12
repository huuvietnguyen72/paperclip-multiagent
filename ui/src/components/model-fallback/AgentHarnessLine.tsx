import { getAdapterDisplay } from "@/adapters/adapter-display-registry";
import { strings } from "@/lib/model-fallback/strings";

/** The harness line under the agent name; shows the fallback harness and a tag while one is in use. */
export function AgentHarnessLine({
  adapterType,
  displayAdapterType,
  model,
  isFallback,
  activeUnknown = false,
}: {
  /** Raw adapter type, picks the brand image. */
  adapterType: string;
  /** Adapter type to label the harness with. */
  displayAdapterType: string;
  model?: string | null;
  isFallback: boolean;
  /** The in-use connection could not be loaded; the configured harness may not be the one running. */
  activeUnknown?: boolean;
}) {
  return (
    <div className="mt-1 flex items-center gap-1.5 text-xs leading-4 text-muted-foreground">
      {adapterType === "claude_local" || adapterType === "codex_local"
        ? <img src={`/brands/${adapterType === "claude_local" ? "claude" : "codex"}-color.svg`} className="-ml-0.5 size-3.5" alt="" />
        : null}
      <span>{getAdapterDisplay(displayAdapterType).label}</span>
      {isFallback && model ? <span data-testid="agent-harness-model" className="truncate">· {model}</span> : null}
      {isFallback ? (
        <span data-testid="agent-harness-fallback-tag" className="rounded-full bg-muted px-1.5 text-foreground">
          {strings.activeFallbackTag}
        </span>
      ) : null}
      {!isFallback && activeUnknown ? (
        <span
          data-testid="agent-harness-unknown"
          className="rounded-full bg-muted px-1.5 text-muted-foreground"
          title={strings.activeUnknown}
          aria-label={strings.activeUnknown}
        >
          {strings.activeUnknownMark}
        </span>
      ) : null}
    </div>
  );
}
