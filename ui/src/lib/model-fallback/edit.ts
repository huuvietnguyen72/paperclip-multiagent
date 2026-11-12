import {
  MODEL_FALLBACK_CARRY_KEYS,
  MODEL_FALLBACK_DEFAULT_CONNECTION_ID,
  MODEL_FALLBACK_MAX_CONNECTIONS,
  type AiRuntimeConnectionBinding,
  type ModelFallbackConfig,
  type ModelFallbackConnection,
} from "@paperclipai/shared";
import { codexLocalReasoningEffortsForModel } from "@paperclipai/adapter-codex-local";
import { createUuid } from "@/lib/uuid";
import { swapDefault } from "./format";

/** The slice of an agent the chain editors read. */
export interface ChainAgent {
  adapterType: string;
  adapterConfig: Record<string, unknown>;
  runtimeConfig: Record<string, unknown>;
}

export interface AgentPatchBody {
  adapterType?: string;
  adapterConfig?: Record<string, unknown>;
  runtimeConfig: Record<string, unknown>;
}

export interface ConnectionEdit {
  model: string;
  /** "" clears the key (Auto). */
  effort: string;
  aiConnection?: AiRuntimeConnectionBinding | null;
}

/** adapterConfig key holding the thinking effort per harness; harnesses without one return null. */
export function effortKeyFor(adapterType: string): string | null {
  if (adapterType === "claude_local") return "effort";
  if (adapterType === "codex_local") return "modelReasoningEffort";
  if (adapterType === "opencode_local") return "variant";
  return null;
}

/**
 * Levels each harness accepts (claude --effort, codex model_reasoning_effort, opencode --variant). Codex levels come
 * from the adapter's per-model list, so "max"/"ultra" appear only for models that support them.
 */
export function effortLevelsFor(adapterType: string, model?: string | null): string[] {
  if (adapterType === "claude_local") return ["low", "medium", "high", "xhigh", "max"];
  if (adapterType === "codex_local") return [...codexLocalReasoningEffortsForModel(model)];
  if (adapterType === "opencode_local") return ["minimal", "low", "medium", "high", "xhigh", "max"];
  return [];
}

export const OPENCODE_DEFAULT_MODEL = "opencode-go/deepseek-v4.1-flash";

export function readFallback(agent: ChainAgent): ModelFallbackConfig {
  const raw = (agent.runtimeConfig ?? {}).modelFallback as ModelFallbackConfig | undefined;
  return { enabled: raw?.enabled ?? true, connections: raw?.connections ?? [], ...(raw?.noResetWaitMinutes != null ? { noResetWaitMinutes: raw.noResetWaitMinutes } : {}) };
}

function withFallback(agent: ChainAgent, next: ModelFallbackConfig): Record<string, unknown> {
  return { ...(agent.runtimeConfig ?? {}), modelFallback: next };
}

function applyEdit(config: Record<string, unknown>, adapterType: string, edit: ConnectionEdit): Record<string, unknown> {
  const next: Record<string, unknown> = { ...config, model: edit.model };
  const key = effortKeyFor(adapterType);
  if (key) {
    if (edit.effort) next[key] = edit.effort;
    else delete next[key];
  }
  return next;
}

/** Editing the default writes the agent's own fields so the Harness / Runtime tab shows the same values. */
export function editDefaultBody(agent: ChainAgent, edit: ConnectionEdit): AgentPatchBody {
  const runtimeConfig = { ...(agent.runtimeConfig ?? {}) };
  if (edit.aiConnection !== undefined) {
    if (edit.aiConnection) runtimeConfig.aiConnection = edit.aiConnection;
    else delete runtimeConfig.aiConnection;
  }
  return {
    adapterType: agent.adapterType,
    adapterConfig: applyEdit(agent.adapterConfig ?? {}, agent.adapterType, edit),
    runtimeConfig,
  };
}

export function editFallbackBody(agent: ChainAgent, connectionId: string, edit: ConnectionEdit): AgentPatchBody {
  const fallback = readFallback(agent);
  const connections = fallback.connections.map((connection) => {
    if (connection.id !== connectionId) return connection;
    const next: ModelFallbackConnection = {
      ...connection,
      adapterConfig: applyEdit(connection.adapterConfig, connection.adapterType, edit),
    };
    if (edit.aiConnection !== undefined) {
      if (edit.aiConnection) next.aiConnection = edit.aiConnection;
      else delete next.aiConnection;
    }
    return next;
  });
  return { runtimeConfig: withFallback(agent, { ...fallback, connections }) };
}

export function removeFallbackBody(agent: ChainAgent, connectionId: string): AgentPatchBody {
  const fallback = readFallback(agent);
  return {
    runtimeConfig: withFallback(agent, { ...fallback, connections: fallback.connections.filter((connection) => connection.id !== connectionId) }),
  };
}

export function canAddConnection(agent: ChainAgent): boolean {
  return readFallback(agent).connections.length < MODEL_FALLBACK_MAX_CONNECTIONS;
}

export function addConnectionBody(agent: ChainAgent, connection: ModelFallbackConnection): AgentPatchBody {
  const fallback = readFallback(agent);
  return { runtimeConfig: withFallback(agent, { ...fallback, connections: [...fallback.connections, connection] }) };
}

export type AddConnectionKind = "opencodeGo" | "claudeAccount" | "codex";

export const ADD_KIND_ORDER: readonly AddConnectionKind[] = ["opencodeGo", "claudeAccount", "codex"];

export function adapterTypeForKind(kind: AddConnectionKind): ModelFallbackConnection["adapterType"] {
  if (kind === "opencodeGo") return "opencode_local";
  if (kind === "codex") return "codex_local";
  return "claude_local";
}

/** Build the new chain entry. A Claude connection copies the default's Claude-specific (non carry) keys. */
export function buildNewConnection(
  agent: ChainAgent,
  kind: AddConnectionKind,
  input: { model: string; aiConnection?: AiRuntimeConnectionBinding },
): ModelFallbackConnection {
  const adapterType = adapterTypeForKind(kind);
  const adapterConfig: Record<string, unknown> = {};
  if (adapterType === "claude_local" && agent.adapterType === "claude_local") {
    for (const [key, value] of Object.entries(agent.adapterConfig ?? {})) {
      if (!MODEL_FALLBACK_CARRY_KEYS.includes(key)) adapterConfig[key] = value;
    }
  }
  adapterConfig.model = input.model;
  return {
    id: createUuid(),
    adapterType,
    adapterConfig,
    ...(input.aiConnection ? { aiConnection: input.aiConnection } : {}),
  };
}

export function sameBinding(a: AiRuntimeConnectionBinding | null | undefined, b: AiRuntimeConnectionBinding | null | undefined): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * `orderedIds` is the whole chain, default first. Dropping a fallback on slot 1 sets it as the default
 * (the old default is demoted; its new id replaces "default" in the rest of the order). Connections missing
 * from `orderedIds` are appended, never dropped.
 */
export function reorderBody(agent: ChainAgent, orderedIds: string[]): AgentPatchBody {
  const first = orderedIds[0];
  let base: AgentPatchBody | null = null;
  let working = agent;
  let rest = orderedIds.slice(1);
  if (first !== MODEL_FALLBACK_DEFAULT_CONNECTION_ID) {
    const originalIds = new Set(readFallback(agent).connections.map((connection) => connection.id));
    base = swapDefault(agent, first);
    working = { ...agent, runtimeConfig: base.runtimeConfig };
    const demoted = readFallback(working).connections.find((connection) => !originalIds.has(connection.id));
    rest = rest.map((id) => (id === MODEL_FALLBACK_DEFAULT_CONNECTION_ID && demoted ? demoted.id : id));
  }
  const fallback = readFallback(working);
  const byId = new Map(fallback.connections.map((connection) => [connection.id, connection] as const));
  const ordered: ModelFallbackConnection[] = [];
  for (const id of rest) {
    const connection = byId.get(id);
    if (connection) {
      ordered.push(connection);
      byId.delete(id);
    }
  }
  const connections = [...ordered, ...byId.values()];
  const runtimeConfig = withFallback(working, { ...fallback, connections });
  return base ? { ...base, runtimeConfig } : { runtimeConfig };
}

export function settingsBody(agent: ChainAgent, settings: { enabled: boolean; noResetWaitMinutes?: number }): AgentPatchBody {
  const fallback = readFallback(agent);
  const next: ModelFallbackConfig = { ...fallback, enabled: settings.enabled };
  if (settings.noResetWaitMinutes != null) next.noResetWaitMinutes = settings.noResetWaitMinutes;
  else delete next.noResetWaitMinutes;
  return { runtimeConfig: withFallback(agent, next) };
}
