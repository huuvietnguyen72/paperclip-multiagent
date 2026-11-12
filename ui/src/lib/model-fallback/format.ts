import {
  MODEL_FALLBACK_CARRY_KEYS,
  type ModelFallbackConfig,
  type ModelFallbackConnection,
} from "@paperclipai/shared";
import { getAdapterDisplay } from "@/adapters/adapter-display-registry";
import { createUuid } from "@/lib/uuid";
import { modelBadgeFor } from "@/lib/office/model-badge";

export function formatRemaining(until: Date, now: Date): string {
  const minutes = Math.floor((until.getTime() - now.getTime()) / 60_000);
  if (minutes < 1) return "còn <1p";
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours > 0 ? `còn ${hours}g ${rest}p` : `còn ${rest}p`;
}

/** "12p" / "1g 5p" elapsed since `from`. */
export function formatElapsed(from: Date | string, now: Date): string {
  const start = typeof from === "string" ? new Date(from) : from;
  const minutes = Math.max(0, Math.floor((now.getTime() - start.getTime()) / 60_000));
  const hours = Math.floor(minutes / 60);
  return hours > 0 ? `${hours}g ${minutes % 60}p` : `${minutes}p`;
}

/** Local-time "HH:mm". */
export function formatClock(value: Date | string): string {
  const date = typeof value === "string" ? new Date(value) : value;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function connectionLabel(adapterType: string, model: string | null | undefined): string {
  const raw = (model ?? "").trim();
  const slash = raw.indexOf("/");
  const providerPrefix = slash > 0 ? raw.slice(0, slash) : null;
  const adapterName =
    providerPrefix === "opencode-go" ? "OpenCode Go" : getAdapterDisplay(adapterType).label;
  if (!raw) return adapterName;
  // modelBadgeFor renders GLM ids as "GLM-5.3"; the connection copy reads "GLM 5.3".
  const modelName = modelBadgeFor(adapterType, raw).label.replace(/^GLM-(?=\d)/, "GLM ");
  return `${adapterName} · ${modelName}`;
}

interface SwapAgent {
  adapterType: string;
  adapterConfig: Record<string, unknown>;
  runtimeConfig: Record<string, unknown>;
}

export interface SwapDefaultBody {
  adapterType: string;
  adapterConfig: Record<string, unknown>;
  runtimeConfig: Record<string, unknown>;
}

/** PATCH body for "Đặt mặc định": the chosen fallback becomes the default and the old default takes its slot. */
export function swapDefault(agent: SwapAgent, connectionId: string): SwapDefaultBody {
  const runtimeConfig = { ...(agent.runtimeConfig ?? {}) } as Record<string, unknown>;
  const fallback = runtimeConfig.modelFallback as ModelFallbackConfig | undefined;
  const connections = fallback?.connections ?? [];
  const index = connections.findIndex((connection) => connection.id === connectionId);
  if (!fallback || index < 0) throw new Error(`Unknown fallback connection ${connectionId}`);
  const chosen = connections[index];

  const carried: Record<string, unknown> = {};
  const oldOwn: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(agent.adapterConfig ?? {})) {
    if (MODEL_FALLBACK_CARRY_KEYS.includes(key)) carried[key] = value;
    else oldOwn[key] = value;
  }

  const oldAiConnection = runtimeConfig.aiConnection as ModelFallbackConnection["aiConnection"] | undefined;
  const demoted: ModelFallbackConnection = {
    id: createUuid(),
    adapterType: agent.adapterType as ModelFallbackConnection["adapterType"],
    adapterConfig: oldOwn,
    ...(oldAiConnection ? { aiConnection: oldAiConnection } : {}),
  };

  const nextConnections = connections.slice();
  nextConnections[index] = demoted;
  runtimeConfig.modelFallback = { ...fallback, connections: nextConnections };
  if (chosen.aiConnection) runtimeConfig.aiConnection = chosen.aiConnection;
  else delete runtimeConfig.aiConnection;

  return {
    adapterType: chosen.adapterType,
    adapterConfig: { ...chosen.adapterConfig, ...carried },
    runtimeConfig,
  };
}
