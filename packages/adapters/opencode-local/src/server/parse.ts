import { asString, parseJson, parseObject } from "@paperclipai/adapter-utils/server-utils";

function errorText(value: unknown): string {
  if (typeof value === "string") return value;
  const rec = parseObject(value);
  const message = asString(rec.message, "").trim();
  if (message) return message;
  const data = parseObject(rec.data);
  const nestedMessage = asString(data.message, "").trim();
  if (nestedMessage) return nestedMessage;
  const name = asString(rec.name, "").trim();
  if (name) return name;
  const code = asString(rec.code, "").trim();
  if (code) return code;
  try {
    return JSON.stringify(rec);
  } catch {
    return "";
  }
}

export function parseOpenCodeJsonl(stdout: string) {
  return createOpenCodeJsonlParser()(stdout);
}

/** Consume complete JSONL records once, retaining protocol accounting state. */
export function createOpenCodeJsonlParser() {
  let sessionId: string | null = null;
  const messages: string[] = [];
  const errors: string[] = [];
  const toolErrors: string[] = [];
  const usage = {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
  };
  let costUsd: number | null = null;
  let missingCost = false;
  let usageReported = false;
  let missingUsage = false;

  return (stdout: string) => {
    for (const rawLine of stdout.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;

      const event = parseJson(line);
      if (!event) continue;

      const currentSessionId = asString(event.sessionID, "").trim();
      if (currentSessionId) sessionId = currentSessionId;

      const type = asString(event.type, "");

      if (type === "text") {
        const part = parseObject(event.part);
        const text = asString(part.text, "").trim();
        if (text) messages.push(text);
        continue;
      }

      if (type === "step_finish") {
        const part = parseObject(event.part);
        const tokens = parseObject(part.tokens);
        const cache = parseObject(tokens.cache);
        const counts = [tokens.input, tokens.output, cache.read === undefined ? 0 : cache.read, cache.write === undefined ? 0 : cache.write, tokens.reasoning === undefined ? 0 : tokens.reasoning];
        if (counts.every(value => typeof value === "number" && Number.isSafeInteger(value) && value >= 0)) {
          const [input, output, cached, written, reasoning] = counts as number[];
          const next = { inputTokens: usage.inputTokens + input + written,
            outputTokens: usage.outputTokens + output + reasoning, cachedInputTokens: usage.cachedInputTokens + cached };
          if (Object.values(next).every(Number.isSafeInteger)) { Object.assign(usage, next); usageReported = true; }
          else missingUsage = true;
        } else missingUsage = true;
        if (typeof part.cost === "number" && Number.isFinite(part.cost) && part.cost >= 0) costUsd = (costUsd ?? 0) + part.cost;
        else missingCost = true;
        continue;
      }

      if (type === "tool_use") {
        const part = parseObject(event.part);
        const state = parseObject(part.state);
        if (asString(state.status, "") === "error") {
          const text = asString(state.error, "").trim();
          if (text) toolErrors.push(text);
        }
        continue;
      }

      if (type === "error") {
        const text = errorText(event.error ?? event.message).trim();
        if (text) errors.push(text);
        continue;
      }
    }

    return {
      sessionId,
      summary: messages.join("\n\n").trim(),
      usage: { ...usage },
      usageReported,
      usageComplete: usageReported && !missingUsage,
      costUsd: missingCost ? null : costUsd,
      errorMessage: errors.length > 0 ? errors.join("\n") : null,
      toolErrors,
    };
  };
}

/** OpenCode's errors for a model the provider refuses (switched off for the account, or unknown to it). */
const OPENCODE_MODEL_UNAVAILABLE_PATTERNS = [/\bmodel access is disabled\b/i, /\bProviderModelNotFoundError\b/];
const PROVIDER_FAILURE_MESSAGE_MAX = 4000;

/**
 * A `paperclip.provider-failure.v1` record (see `@paperclipai/shared` `ProviderFailure`) for a model OpenCode refuses,
 * e.g. "Model access is disabled. Change model access at https://opencode.ai/console/…/models." Other failures get none.
 * The server reads it from the run's resultJson to move an agent off a fallback connection whose model cannot run.
 */
export function openCodeModelUnavailableFailure(errorMessage: string | null | undefined) {
  const message = (errorMessage ?? "").trim();
  if (!message || !OPENCODE_MODEL_UNAVAILABLE_PATTERNS.some((pattern) => pattern.test(message))) return null;
  return {
    schema: "paperclip.provider-failure.v1" as const,
    provider: "opencode",
    phase: "turn" as const,
    category: "model_unavailable" as const,
    message: [...message].slice(0, PROVIDER_FAILURE_MESSAGE_MAX).join(""),
    retryability: "requires_action" as const,
  };
}

export function isOpenCodeUnknownSessionError(stdout: string, stderr: string): boolean {
  const haystack = `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");

  return /unknown\s+session|session\b.*\bnot\s+found|resource\s+not\s+found:.*[\\/]session[\\/].*\.json|notfounderror|no session/i.test(
    haystack,
  );
}
