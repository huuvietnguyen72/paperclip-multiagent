import { isAiConnectionCompatible, type ModelFallbackConfig } from "@paperclipai/shared";

/** Adapters that may appear as fallback connections. paperclip_runner is excluded (ruling P8). */
export const MODEL_FALLBACK_ADAPTER_TYPES: readonly string[] = ["claude_local", "codex_local", "opencode_local"];

/**
 * Validates the semantic rules of a `runtimeConfig.modelFallback` value on top of the
 * shape check done by the shared schema. Returns an error message, or null when valid.
 */
export function validateModelFallbackPatch(input: {
  modelFallback: ModelFallbackConfig | null | undefined;
  /** The agent's resulting adapter type after the patch. */
  adapterType: string;
}): string | null {
  const { modelFallback, adapterType } = input;
  if (!modelFallback) return null;
  if (modelFallback.enabled && adapterType === "paperclip_runner") {
    return "Model fallback is not available for agents that use the Paperclip runner";
  }
  for (const [index, connection] of modelFallback.connections.entries()) {
    const position = `Fallback connection ${index + 1}`;
    if (!MODEL_FALLBACK_ADAPTER_TYPES.includes(connection.adapterType)) {
      return `${position}: adapter type ${connection.adapterType} is not supported for model fallback (use ${MODEL_FALLBACK_ADAPTER_TYPES.join(", ")})`;
    }
    if (connection.aiConnection && connection.aiConnection.mode !== "router"
      && !isAiConnectionCompatible(connection.aiConnection, connection.adapterType, connection.adapterConfig.model)) {
      return `${position}: the AI connection is not compatible with ${connection.adapterType} and model ${String(connection.adapterConfig.model)}`;
    }
  }
  return null;
}
