import { readProviderFailure } from "@paperclipai/shared";
import { readDispatchRecord } from "./policy.js";

/**
 * Why a fallback connection cannot run. A model that the provider refuses blocks only that model on its account;
 * an account that cannot authenticate (or was revoked) blocks every model on it, like an exhausted account.
 */
export type FallbackFailureKind = "model_unusable" | "account_unusable";

type FailedRun = { errorCode: string | null; error: string | null; resultJson: unknown; runnerProfileJson: unknown };

/** Adapter error codes for a provider login that is missing, expired or revoked. */
const ACCOUNT_AUTH_ERROR_CODES = new Set([
  "claude_auth_required",
  "acpx_auth_required",
  "codex_auth_required",
  "gemini_auth_required",
  "kimi_auth_required",
]);
/** Adapter error families for a provider login that can no longer refresh. */
const ACCOUNT_ERROR_FAMILIES = new Set(["refresh_token_reused", "refresh_token_expired", "refresh_token_invalidated"]);
/** Families that already have their own recovery path (quota exhaustion moves the chain on its own). */
const OWN_PATH_FAMILIES = new Set(["provider_quota", "transient_upstream"]);
/** Provider failure categories that say the connection itself is fine. */
const USABLE_CATEGORIES = new Set(["rate_limit", "quota_exhausted", "overloaded", "timeout", "invalid_request"]);

// Conservative text patterns, matched against the run's own error line only (never against the agent's output).
const MODEL_UNUSABLE_PATTERNS = [
  /\bmodel access is disabled\b/i,
  /\bProviderModelNotFoundError\b/,
  /\bmodel_not_found\b/,
  // "Model not found: x", "The model `x` is not available", "model x does not exist", "model is not enabled".
  /\bmodel\s+(?:[`'"]?[\w./:@-]+[`'"]?\s+)?(?:is\s+)?(?:not\s+(?:found|available|enabled|allowed|supported)|does\s+not\s+exist|disabled)\b/i,
];
const ACCOUNT_UNUSABLE_PATTERNS = [
  /\bReconnect or validate the selected AI account\b/i,
  /\bauthentication_error\b/,
  /\binvalid (?:x-)?api[ _-]?key\b/i,
];

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/**
 * Classifies a failed run that was dispatched on a FALLBACK connection as "the connection itself cannot run".
 * Structured evidence (error family, provider failure category, error code) wins over text; anything unknown is null
 * and keeps today's behaviour. A run on the default connection is never classified (spec §3.2 rule 5, ruling P10):
 * a configuration problem on the default must reach the owner instead of being hidden by an automatic switch.
 */
export function classifyFallbackFailure(run: FailedRun): { kind: FallbackFailureKind } | null {
  if (readDispatchRecord(run)?.isFallback !== true) return null;
  const resultJson = asRecord(run.resultJson);
  const family = readString(resultJson.errorFamily);
  if (run.errorCode === "provider_quota" || (family && OWN_PATH_FAMILIES.has(family))) return null;
  if (family && ACCOUNT_ERROR_FAMILIES.has(family)) return { kind: "account_unusable" };

  const providerFailure = readProviderFailure(resultJson.providerFailure);
  if (providerFailure) {
    if (providerFailure.category === "model_unavailable") return { kind: "model_unusable" };
    if (providerFailure.category === "authentication" || providerFailure.category === "permission") return { kind: "account_unusable" };
    if (USABLE_CATEGORIES.has(providerFailure.category)) return null;
    if (providerFailure.httpStatus === 401 || providerFailure.httpStatus === 403) return { kind: "account_unusable" };
  }

  if (run.errorCode === "model_not_found") return { kind: "model_unusable" };
  if (run.errorCode && ACCOUNT_AUTH_ERROR_CODES.has(run.errorCode)) return { kind: "account_unusable" };
  if (asRecord(resultJson.configurationIncomplete).reason === "ai_connection_unavailable") return { kind: "account_unusable" };

  const error = readString(run.error);
  if (!error) return null;
  if (MODEL_UNUSABLE_PATTERNS.some((pattern) => pattern.test(error))) return { kind: "model_unusable" };
  if (ACCOUNT_UNUSABLE_PATTERNS.some((pattern) => pattern.test(error))) return { kind: "account_unusable" };
  return null;
}
