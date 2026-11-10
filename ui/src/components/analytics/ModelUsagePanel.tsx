import { AdapterMark } from "@/components/AdapterMark";
import type { AgentModelUsage, ModelUsage } from "@/lib/analytics/model-usage";
import { analyticsStrings as s } from "@/lib/analytics/strings";
import { formatSpend, formatTokens } from "@/lib/office/stats";
import { cn } from "@/lib/utils";

function Bar({ fraction }: { fraction: number }) {
  return (
    <span className="block h-3 min-w-0 flex-1 rounded-sm bg-muted">
      <span className="block h-3 rounded-r-sm bg-(--series-1)" style={{ width: `${Math.max(1, fraction * 100)}%` }} />
    </span>
  );
}

/** Models ranked by tokens (one hue, magnitude only) and the top agents of the selected model. */
export function ModelUsagePanel({ models, selectedModel, onSelectModel, topAgents }: {
  models: ModelUsage[];
  selectedModel: string | null;
  onSelectModel(model: string): void;
  topAgents: AgentModelUsage[];
}) {
  if (models.length === 0) return <p className="text-xs text-muted-foreground">{s.empty}</p>;
  const maxModel = models[0].tokens;
  const selected = models.find((model) => model.model === selectedModel) ?? models[0];
  const maxAgent = topAgents[0]?.tokens ?? 1;
  return (
    // Ranking and top agents side by side under the full-width work chart.
    <div data-model-lists className="grid gap-6 md:grid-cols-2">
      <div className="flex flex-col gap-1">
        <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{s.models.ranking}</h3>
        {models.map((model) => (
          <button
            key={model.model}
            type="button"
            data-model={model.model}
            aria-pressed={model.model === selected.model}
            title={`${formatTokens(model.tokens)} ${s.models.tokens} · ${formatSpend(model.costCents)}`}
            onClick={() => onSelectModel(model.model)}
            className={cn(
              "flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent",
              model.model === selected.model && "bg-accent",
            )}
          >
            <span className="inline-flex w-32 min-w-0 shrink-0 items-center gap-1.5 text-foreground">
              <AdapterMark type={model.markType} className="size-3.5" />
              <span className="truncate">{model.label}</span>
            </span>
            <Bar fraction={model.tokens / maxModel} />
            <span className="font-mono text-foreground">{formatTokens(model.tokens)}</span>
          </button>
        ))}
      </div>
      <div data-top-agents className="flex flex-col gap-1">
        <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{s.models.topAgents(selected.label)}</h3>
        {topAgents.map((agent) => (
          <div
            key={agent.agentId ?? agent.agentName}
            title={`${formatTokens(agent.tokens)} ${s.models.tokens} · ${formatSpend(agent.costCents)}`}
            className="flex items-center gap-2 px-2 py-1.5 text-xs"
          >
            <span className="w-32 shrink-0 truncate text-foreground">{agent.agentName}</span>
            <Bar fraction={agent.tokens / maxAgent} />
            <span className="font-mono text-foreground">{formatTokens(agent.tokens)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
