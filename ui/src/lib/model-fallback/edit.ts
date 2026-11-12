import {
  MODEL_FALLBACK_CARRY_KEYS,
  MODEL_FALLBACK_DEFAULT_CONNECTION_ID,
  MODEL_FALLBACK_MAX_CONNECTIONS,
  type AiRuntimeConnectionBinding,
  type ModelFallbackConfig,
  type ModelFallbackConnection,
} from "@paperclipai/shared";
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
  return null;
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

export type AddConnectionKind = "opencodeGo" | "claudeAccount" | "codex" | "anthropicCompatible";

export const ADD_KIND_ORDER: readonly AddConnectionKind[] = ["opencodeGo", "claudeAccount", "codex", "anthropicCompatible"];

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

/** `orderedIds` is the whole chain, default first. Dropping a fallback on slot 1 sets it as the default. */
export function reorderBody(agent: ChainAgent, orderedIds: string[]): AgentPatchBody {
  const first = orderedIds[0];
  if (first !== MODEL_FALLBACK_DEFAULT_CONNECTION_ID) return swapDefault(agent, first);
  const fallback = readFallback(agent);
  const byId = new Map(fallback.connections.map((connection) => [connection.id, connection] as const));
  const connections = orderedIds
    .slice(1)
    .map((id) => byId.get(id))
    .filter((connection): connection is ModelFallbackConnection => Boolean(connection));
  return { runtimeConfig: withFallback(agent, { ...fallback, connections }) };
}

export function settingsBody(agent: ChainAgent, settings: { enabled: boolean; noResetWaitMinutes?: number }): AgentPatchBody {
  const fallback = readFallback(agent);
  const next: ModelFallbackConfig = { ...fallback, enabled: settings.enabled };
  if (settings.noResetWaitMinutes != null) next.noResetWaitMinutes = settings.noResetWaitMinutes;
  else delete next.noResetWaitMinutes;
  return { runtimeConfig: withFallback(agent, next) };
}
