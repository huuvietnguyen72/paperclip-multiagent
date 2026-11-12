import type { CompanyModelFallbackActive } from "@paperclipai/shared";

export type ActiveFallbackEntry = CompanyModelFallbackActive[number];

export interface EffectiveModel {
  adapterType: string;
  model: string | null;
  /** True when the agent currently runs on a fallback connection instead of its configured one. */
  isFallback: boolean;
}

/** agentId -> active entry, for the entries that are actually a fallback. */
export function fallbackActiveMap(active: CompanyModelFallbackActive | null | undefined): ReadonlyMap<string, ActiveFallbackEntry> {
  const map = new Map<string, ActiveFallbackEntry>();
  for (const entry of active ?? []) if (entry.isFallback) map.set(entry.agentId, entry);
  return map;
}

/**
 * The adapter type and model an agent is really using. Single source for the agent header and Office, so
 * both agree: the active fallback connection when there is one, otherwise the agent's configured values.
 */
export function effectiveModelFor(
  agent: { id: string; adapterType: string; adapterConfig?: Record<string, unknown> | null },
  active: ReadonlyMap<string, ActiveFallbackEntry> | undefined,
): EffectiveModel {
  const entry = active?.get(agent.id);
  if (entry?.isFallback) {
    return { adapterType: entry.adapterType, model: entry.model || null, isFallback: true };
  }
  const configured = agent.adapterConfig?.model;
  return {
    adapterType: agent.adapterType,
    model: typeof configured === "string" ? configured : null,
    isFallback: false,
  };
}
