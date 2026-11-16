import { readProviderFailure } from "@paperclipai/shared";
import { readHeartbeatRunErrorFamily } from "../heartbeat/retries.js";
import { readDispatchRecord } from "./policy.js";

/**
 * Why a fallback connection cannot run. A model that the provider refuses blocks only that model on its account;
 * an account that cannot authenticate (or was revoked) blocks every model on it.
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
/**
 * select()'s deliberate account-level rejections (ai-connections.ts): the bound connection or grant is gone, disabled,
 * unhealthy or needs a new sign-in. Every other configuration failure (env routing, project auth, an incompatible
 * binding, a membership 403, DB or credential I/O) is wrapped under the same reason and proves nothing about the account.
 */
const ACCOUNT_SELECTION_FAILURES = new Set(["ai_connection_unavailable", "ai_connection_missing"]);
/**
 * OpenCode's own error signatures for a model the provider refuses. Only OpenCode's error line is provider output;
 * Claude's is the CLI's final result text (agent prose), so Claude relies on its error codes alone.
 */
const OPENCODE_MODEL_UNUSABLE_SIGNATURES = [/\bModel access is disabled\b/, /\bProviderModelNotFoundError\b/];

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * Classifies a failed run that was dispatched on a FALLBACK connection as "the connection itself cannot run".
 * Structured evidence (error family, provider failure category, error code, select() rejection) decides; the only text
 * accepted is OpenCode's exact provider signature. Anything unknown is null and keeps today's behaviour. A run on the
 * default connection is never classified (spec §3.2 rule 5, ruling P10): a configuration problem on the default must
 * reach the owner instead of being hidden by an automatic switch.
 */
export function classifyFallbackFailure(run: FailedRun): { kind: FallbackFailureKind } | null {
  const record = readDispatchRecord(run);
  if (record?.isFallback !== true) return null;
  const resultJson = asRecord(run.resultJson);
  const family = readHeartbeatRunErrorFamily({ errorCode: run.errorCode, resultJson: run.resultJson as Record<string, unknown> | null });
  if (family && OWN_PATH_FAMILIES.has(family)) return null;
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
  const configurationIncomplete = asRecord(resultJson.configurationIncomplete);
  if (configurationIncomplete.reason === "ai_connection_unavailable"
    && typeof configurationIncomplete.selectionFailure === "string"
    && ACCOUNT_SELECTION_FAILURES.has(configurationIncomplete.selectionFailure)) {
    return { kind: "account_unusable" };
  }

  // Runs from before the adapter reported the structured failure, and any OpenCode path that does not.
  if (record.adapterType === "opencode_local" && typeof run.error === "string"
    && OPENCODE_MODEL_UNUSABLE_SIGNATURES.some((signature) => signature.test(run.error!))) {
    return { kind: "model_unusable" };
  }
  return null;
}
