import {
  MODEL_FALLBACK_CARRY_KEYS,
  MODEL_FALLBACK_DEFAULT_CONNECTION_ID,
  modelFallbackConfigSchema,
  type AiRuntimeConnectionBinding,
  type ModelFallbackDispatchRecord,
  type ModelFallbackSelectionKind,
} from "@paperclipai/shared";

export type ChainEntry = {
  id: string;
  adapterType: string;
  adapterConfig: Record<string, unknown>;
  aiConnection: AiRuntimeConnectionBinding | null;
};

export type { ModelFallbackSelectionKind };

const SELECTION_KINDS: readonly ModelFallbackSelectionKind[] = ["default", "stay", "return", "switch", "all_exhausted"];

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
  // Ruling P8: native runner claims are exact-match evidence elsewhere, so a runner agent never falls back.
  if (agent.adapterType === "paperclip_runner") return chain;
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

/** Reads the dispatch record the claim stores at runnerProfileJson.adapterDispatch.modelFallback. */
export function readDispatchRecord(run: { runnerProfileJson: unknown }): ModelFallbackDispatchRecord | null {
  const raw = asRecord(asRecord(asRecord(run.runnerProfileJson).adapterDispatch).modelFallback);
  if (typeof raw.connectionId !== "string" || typeof raw.adapterType !== "string") return null;
  return {
    connectionId: raw.connectionId,
    accountKey: typeof raw.accountKey === "string" ? raw.accountKey : null,
    adapterType: raw.adapterType,
    model: typeof raw.model === "string" ? raw.model : null,
    isFallback: raw.isFallback === true,
    ...(SELECTION_KINDS.includes(raw.kind as ModelFallbackSelectionKind) ? { kind: raw.kind as ModelFallbackSelectionKind } : {}),
  };
}

/**
 * The agent a claimed run executes as. A fallback record runs the agent on that chain entry; a record whose
 * connection is no longer in the chain is reported as missing and the agent keeps its own configuration.
 */
export function applyModelFallbackDispatch<A extends AgentLike>(
  agent: A,
  run: { runnerProfileJson: unknown },
): { agent: A; missing: boolean } {
  const record = readDispatchRecord(run);
  if (!record) return { agent, missing: false };
  const entry = buildChain(agent).find((candidate) => candidate.id === record.connectionId);
  if (!entry) return { agent, missing: true };
  return { agent: record.isFallback ? effectiveRunAgent(agent, entry) : agent, missing: false };
}

// Unusable marks (a fallback connection that cannot run) live under their own keys, apart from the plain account key
// that quota exhaustion uses. Marks are company rows, so another agent's default may share the account or model; the
// default never reads them (ruling P10).

/** Blocks one model on an account (a model the provider refuses), not the whole account. */
export function modelScopedKey(accountKey: string, model: string): string {
  return `${accountKey}#model:${model}`;
}

/** Blocks every model on an account that cannot authenticate or was revoked. */
export function accountUnusableKey(accountKey: string): string {
  return `${accountKey}#unusable`;
}

function chainEntryModel(entry: Pick<ChainEntry, "adapterConfig">): string | null {
  const model = entry.adapterConfig.model;
  return typeof model === "string" && model.trim().length > 0 ? model : null;
}

/** The keys a connection honours: the account (quota) key always; the unusable marks only on a fallback tier. */
function connectionKeys(entry: Pick<ChainEntry, "adapterConfig">, accountKey: string, isDefault: boolean): string[] {
  if (isDefault) return [accountKey];
  const model = chainEntryModel(entry);
  return [accountKey, accountUnusableKey(accountKey), ...(model ? [modelScopedKey(accountKey, model)] : [])];
}

/** Every key whose exhaustion row can block a chain entry (see connectionKeys), for one lookup. */
export function exhaustionKeys(chain: ChainEntry[], accountKeys: (string | null)[]): string[] {
  const keys = new Set<string>();
  chain.forEach((entry, index) => {
    const accountKey = accountKeys[index] ?? null;
    if (accountKey === null) return;
    // Listed for every tier: the same account or model may be a fallback further down this chain.
    for (const key of connectionKeys(entry, accountKey, false)) keys.add(key);
  });
  return [...keys];
}

/**
 * Until when a connection is blocked: the latest of the rows it honours; undefined when none. The default
 * (`isDefault`) honours only its account's quota exhaustion, never an unusable mark.
 */
export function connectionExhaustedUntil(
  entry: Pick<ChainEntry, "adapterConfig">,
  accountKey: string | null,
  exhaustedUntil: Map<string, Date>,
  isDefault = false,
): Date | undefined {
  if (accountKey === null) return undefined;
  let latest: Date | undefined;
  for (const key of connectionKeys(entry, accountKey, isDefault)) {
    const until = exhaustedUntil.get(key);
    if (until && (!latest || until.getTime() > latest.getTime())) latest = until;
  }
  return latest;
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

  const untilOf = (index: number) =>
    connectionExhaustedUntil(chain[index]!, accountKeys[index] ?? null, exhaustedUntil, index === 0);
  const isExhausted = (index: number) => {
    const until = untilOf(index);
    return until !== undefined && until.getTime() > now.getTime();
  };
  // Ruling P10: only exhaustion makes the default unusable. An unresolvable default key (a responsible_user binding
  // without a user, a reconnect needed) dispatches the default as configured instead of switching; an unresolvable
  // fallback key is still skipped when choosing a fallback. Unusable marks (#unusable, #model:) never apply to the
  // default: untilOf(0) reads only the account's quota exhaustion.
  const usable = (index: number) =>
    (index === 0 || (accountKeys[index] ?? null) !== null) && !isExhausted(index);

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
    const until = untilOf(index);
    if (until && until.getTime() < earliest) {
      earliest = until.getTime();
      earliestIndex = index;
    }
  }
  if (earliestIndex < 0) return { index: 0, kind: "default" };
  return { index: earliestIndex, kind: "all_exhausted" };
}
