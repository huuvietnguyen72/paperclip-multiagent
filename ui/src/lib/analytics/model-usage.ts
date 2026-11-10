import type { CostByAgentModel } from "@paperclipai/shared";
import { modelBadgeFor } from "@/lib/office/model-badge";

export interface ModelUsage {
  model: string;
  label: string;
  markType: string;
  tokens: number;
  costCents: number;
}

export interface AgentModelUsage {
  agentId: string | null;
  agentName: string;
  tokens: number;
  costCents: number;
}

/** Cost rows name a provider, not an adapter; map known providers to the adapter whose brand mark they share. */
const PROVIDER_MARK: Record<string, string> = {
  anthropic: "claude_local",
  openai: "codex_local",
  "opencode-go": "opencode_local",
  opencode: "opencode_local",
  google: "gemini_local",
  gemini: "gemini_local",
  moonshot: "kimi_local",
  kimi: "kimi_local",
  xai: "grok_local",
};

const tokensOf =(row: CostByAgentModel) => (row.inputTokens ?? 0) + (row.cachedInputTokens ?? 0) + (row.outputTokens ?? 0);

/** Models ranked by total tokens used. */
export function modelUsage(rows: CostByAgentModel[]): ModelUsage[] {
  const byModel = new Map<string, ModelUsage>();
  for (const row of rows) {
    const model = row.model || "unknown";
    const current = byModel.get(model);
    if (current) {
      current.tokens += tokensOf(row);
      current.costCents += row.costCents ?? 0;
    } else {
      const provider = row.provider ?? "";
      const badge = modelBadgeFor(PROVIDER_MARK[provider] ?? provider, model);
      byModel.set(model, { model, label: badge.label, markType: badge.markType, tokens: tokensOf(row), costCents: row.costCents ?? 0 });
    }
  }
  return [...byModel.values()].filter((usage) => usage.tokens > 0).sort((a, b) => b.tokens - a.tokens);
}

/** Every agent that used a model, most tokens first. */
export function topAgentsForModel(rows: CostByAgentModel[], model: string): AgentModelUsage[] {
  const byAgent = new Map<string, AgentModelUsage>();
  for (const row of rows) {
    if ((row.model || "unknown") !== model) continue;
    const key = row.agentId ?? "—";
    const current = byAgent.get(key) ?? { agentId: row.agentId, agentName: row.agentName ?? "—", tokens: 0, costCents: 0 };
    current.tokens += tokensOf(row);
    current.costCents += row.costCents ?? 0;
    byAgent.set(key, current);
  }
  return [...byAgent.values()].filter((usage) => usage.tokens > 0).sort((a, b) => b.tokens - a.tokens);
}
