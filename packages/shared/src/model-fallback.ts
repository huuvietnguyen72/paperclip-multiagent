import { z } from "zod";
import { agentAdapterTypeSchema } from "./adapter-type.js";
import { aiRuntimeConnectionBindingSchema, type AiRuntimeConnectionBinding } from "./ai-connection-router.js";
import type { AgentAdapterType } from "./constants.js";

export const MODEL_FALLBACK_DEFAULT_CONNECTION_ID = "default";
export const MODEL_FALLBACK_RETRY_REASON = "model_fallback_switch";
export const MODEL_FALLBACK_MAX_CONNECTIONS = 10;

/** Issue statuses that count as "finished" for the return-to-default rule. */
export const MODEL_FALLBACK_FINISHED_ISSUE_STATUSES: readonly string[] = [
  "done",
  "in_review",
  "cancelled",
  "blocked",
];

/**
 * adapterConfig keys carried from the agent's default configuration into a
 * fallback run (workspace and instruction wiring, not model/account settings).
 */
export const MODEL_FALLBACK_CARRY_KEYS: readonly string[] = [
  "cwd",
  "instructionsFilePath",
  "instructionsRootPath",
  "instructionsEntryFile",
  "promptTemplate",
  "bootstrapPromptTemplate",
  "timeoutSec",
  "graceSec",
];

export const modelFallbackConnectionSchema = z.object({
  id: z.string().uuid(),
  adapterType: agentAdapterTypeSchema,
  adapterConfig: z
    .record(z.string(), z.unknown())
    .refine((config) => typeof config.model === "string" && config.model.trim().length > 0, {
      message: "adapterConfig.model must be a non-empty string",
      path: ["model"],
    }),
  aiConnection: aiRuntimeConnectionBindingSchema.optional(),
});
export type ModelFallbackConnection = {
  id: string;
  adapterType: AgentAdapterType;
  adapterConfig: Record<string, unknown>;
  aiConnection?: AiRuntimeConnectionBinding;
};

export const modelFallbackConfigSchema = z
  .object({
    enabled: z.boolean(),
    connections: z.array(modelFallbackConnectionSchema).max(MODEL_FALLBACK_MAX_CONNECTIONS),
    noResetWaitMinutes: z.number().int().min(1).max(1440).optional(),
  })
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    value.connections.forEach((connection, index) => {
      if (seen.has(connection.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["connections", index, "id"],
          message: "Connection ids must be unique",
        });
      }
      seen.add(connection.id);
    });
  });
export type ModelFallbackConfig = {
  enabled: boolean;
  connections: ModelFallbackConnection[];
  noResetWaitMinutes?: number;
};

export interface ModelFallbackDispatchRecord {
  connectionId: string;
  accountKey: string | null;
  adapterType: string;
  model: string | null;
  isFallback: boolean;
}

export interface AgentModelFallbackView {
  enabled: boolean;
  noResetWaitMinutes: number;
  active: { connectionId: string; since: string | null; reason: string | null };
  pinnedIssues: Array<{ id: string; identifier: string; title: string; status: string; finished: boolean }>;
  connections: Array<{
    id: string;
    position: number;
    isDefault: boolean;
    adapterType: string;
    model: string | null;
    aiConnection: AiRuntimeConnectionBinding | null;
    accountKey: string | null;
    accountLabel: string | null;
    exhaustedUntil: string | null;
    inUse: boolean;
    lastUsedAt: string | null;
    runsToday: number;
    tokensToday: number;
    quotaWindows: Array<{ label: string; usedPercent: number | null; resetsAt: string | null }>;
  }>;
  today: { switches: number; tokens: number };
  timeline: Array<{
    at: string;
    kind: "run" | "switched" | "returned" | "default_changed";
    status?: string;
    issueIdentifier?: string | null;
    fromModel?: string | null;
    toModel?: string | null;
    model?: string | null;
    durationMs?: number | null;
    reason?: string | null;
    resetAt?: string | null;
  }>;
}

export type CompanyModelFallbackActive = Array<{
  agentId: string;
  connectionId: string;
  adapterType: string;
  model: string | null;
  isFallback: boolean;
}>;
