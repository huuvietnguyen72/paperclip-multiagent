import {
  MODEL_FALLBACK_CARRY_KEYS,
  MODEL_FALLBACK_DEFAULT_CONNECTION_ID,
  modelFallbackConfigSchema,
  type AiRuntimeConnectionBinding,
} from "@paperclipai/shared";

export type ChainEntry = {
  id: string;
  adapterType: string;
  adapterConfig: Record<string, unknown>;
  aiConnection: AiRuntimeConnectionBinding | null;
};

export type ModelFallbackSelectionKind = "default" | "stay" | "return" | "switch" | "all_exhausted";

type AgentLike = { adapterType: string; adapterConfig: unknown; runtimeConfig: unknown };

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Index 0 is the agent's own configuration; fallbacks follow in configured order. */
export function buildChain(agent: AgentLike): ChainEntry[] {
  const runtimeConfig = asRecord(agent.runtimeConfig);
  const chain: ChainEntry[] = [
    {
      id: MODEL_FALLBACK_DEFAULT_CONNECTION_ID,
      adapterType: agent.adapterType,
      adapterConfig: asRecord(agent.adapterConfig),
      aiConnection: (runtimeConfig.aiConnection as AiRuntimeConnectionBinding | undefined) ?? null,
    },
  ];
  const parsed = modelFallbackConfigSchema.safeParse(runtimeConfig.modelFallback);
  if (!parsed.success || !parsed.data.enabled) return chain;
  for (const connection of parsed.data.connections) {
    chain.push({
      id: connection.id,
      adapterType: connection.adapterType,
      adapterConfig: connection.adapterConfig,
      aiConnection: (connection.aiConnection as AiRuntimeConnectionBinding | undefined) ?? null,
    });
  }
  return chain;
}

/** Returns a copy of the agent as it should run on the given chain entry. */
export function effectiveRunAgent<A extends AgentLike>(agent: A, entry: ChainEntry): A {
  if (entry.id === MODEL_FALLBACK_DEFAULT_CONNECTION_ID) return agent;
  const base = asRecord(agent.adapterConfig);
  const carried: Record<string, unknown> = {};
  for (const key of MODEL_FALLBACK_CARRY_KEYS) {
    if (Object.prototype.hasOwnProperty.call(base, key)) carried[key] = base[key];
  }
  const runtimeConfig = { ...asRecord(agent.runtimeConfig) };
  if (entry.aiConnection) runtimeConfig.aiConnection = entry.aiConnection;
  else delete runtimeConfig.aiConnection;
  return {
    ...agent,
    adapterType: entry.adapterType,
    adapterConfig: { ...carried, ...entry.adapterConfig },
    runtimeConfig,
  };
}

export function selectConnection(input: {
  chain: ChainEntry[];
  accountKeys: (string | null)[];
  exhaustedUntil: Map<string, Date>;
  activeConnectionId: string | null;
  pinnedFinished: boolean;
  now: Date;
}): { index: number; kind: ModelFallbackSelectionKind } {
  const { chain, accountKeys, exhaustedUntil, activeConnectionId, pinnedFinished, now } = input;

  const isExhausted = (index: number) => {
    const key = accountKeys[index];
    if (key == null) return false;
    const until = exhaustedUntil.get(key);
    return until !== undefined && until.getTime() > now.getTime();
  };
  const usable = (index: number) => (accountKeys[index] ?? null) !== null && !isExhausted(index);

  const foundIndex = activeConnectionId ? chain.findIndex((entry) => entry.id === activeConnectionId) : -1;
  const current = foundIndex < 0 ? 0 : foundIndex;

  if (current > 0 && pinnedFinished && usable(0)) return { index: 0, kind: "return" };
  if (usable(current)) return { index: current, kind: current === 0 ? "default" : "stay" };

  for (let index = 0; index < chain.length; index += 1) {
    if (usable(index)) return { index, kind: "switch" };
  }

  let earliestIndex = -1;
  let earliest = Infinity;
  for (let index = 0; index < chain.length; index += 1) {
    const key = accountKeys[index];
    if (key == null) continue;
    const until = exhaustedUntil.get(key);
    if (until && until.getTime() < earliest) {
      earliest = until.getTime();
      earliestIndex = index;
    }
  }
  if (earliestIndex < 0) return { index: 0, kind: "default" };
  return { index: earliestIndex, kind: "all_exhausted" };
}
