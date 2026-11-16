import { describe, expect, it } from "vitest";
import { classifyFallbackFailure } from "./classify.js";

// The real failure text of the 2026-11-16 incident (workspace id shortened).
const OPENCODE_MODEL_DISABLED = "Model access is disabled. Change model access at https://opencode.ai/console/wrk_01J/models.";

const dispatch = (modelFallback: Record<string, unknown>) => ({
  adapterDispatch: { adapterType: modelFallback.adapterType, modelFallback },
});
const opencodeFallback = dispatch({
  connectionId: "22222222-2222-4222-8222-222222222222", accountKey: "login:opencode_local",
  adapterType: "opencode_local", model: "opencode-go/glm-5.3", isFallback: true, kind: "switch",
});
const claudeFallback = dispatch({
  connectionId: "33333333-3333-4333-8333-333333333333", accountKey: "ai:other",
  adapterType: "claude_local", model: "claude-sonnet-5-5", isFallback: true, kind: "switch",
});
const defaultDispatch = dispatch({
  connectionId: "default", accountKey: "ai:own", adapterType: "claude_local", model: "claude-sonnet-5-5", isFallback: false,
});

type RunPatch = { errorCode?: string | null; error?: string | null; resultJson?: unknown; runnerProfileJson?: unknown };
function failed(patch: RunPatch = {}) {
  return { errorCode: "adapter_failed", error: null, resultJson: null, runnerProfileJson: opencodeFallback, ...patch };
}

describe("classifyFallbackFailure", () => {
  it("classifies the real OpenCode 'Model access is disabled' failure as model_unusable", () => {
    expect(classifyFallbackFailure(failed({ error: OPENCODE_MODEL_DISABLED }))).toEqual({ kind: "model_unusable" });
    expect(classifyFallbackFailure(failed({ error: "ProviderModelNotFoundError: opencode-go/glm-9" }))).toEqual({ kind: "model_unusable" });
  });

  it("prefers a structured provider failure category over the text", () => {
    const providerFailure = (category: string, extra: Record<string, unknown> = {}) => ({
      providerFailure: { schema: "paperclip.provider-failure.v1", provider: "opencode", phase: "turn", category,
        message: "provider said no", retryability: "requires_action", ...extra },
    });
    expect(classifyFallbackFailure(failed({ error: "boom", resultJson: providerFailure("model_unavailable") })))
      .toEqual({ kind: "model_unusable" });
    expect(classifyFallbackFailure(failed({ error: "boom", resultJson: providerFailure("authentication") })))
      .toEqual({ kind: "account_unusable" });
    expect(classifyFallbackFailure(failed({ error: "boom", resultJson: providerFailure("permission") })))
      .toEqual({ kind: "account_unusable" });
    expect(classifyFallbackFailure(failed({ error: "boom", resultJson: providerFailure("unknown", { httpStatus: 401 }) })))
      .toEqual({ kind: "account_unusable" });
    // A definite non-unusable category wins over a matching text.
    expect(classifyFallbackFailure(failed({ error: OPENCODE_MODEL_DISABLED, resultJson: providerFailure("overloaded") })))
      .toBeNull();
  });

  it("classifies a login the provider rejects by its adapter error code or family", () => {
    expect(classifyFallbackFailure(failed({ runnerProfileJson: claudeFallback, errorCode: "claude_auth_required", error: "Please run /login" })))
      .toEqual({ kind: "account_unusable" });
    expect(classifyFallbackFailure(failed({ errorCode: "codex_failed", resultJson: { errorFamily: "refresh_token_expired" } })))
      .toEqual({ kind: "account_unusable" });
    expect(classifyFallbackFailure(failed({ runnerProfileJson: claudeFallback, errorCode: "model_not_found", error: "model missing" })))
      .toEqual({ kind: "model_unusable" });
  });

  it("classifies a configuration failure as account_unusable only for select()'s account-level rejections", () => {
    const configurationFailure = (configurationIncomplete: Record<string, unknown>) => failed({
      runnerProfileJson: claudeFallback, errorCode: "configuration_incomplete", error: "Reconnect or validate the selected AI account",
      resultJson: { configurationIncomplete },
    });
    for (const selectionFailure of ["ai_connection_unavailable", "ai_connection_missing"]) {
      expect(classifyFallbackFailure(configurationFailure({ reason: "ai_connection_unavailable", selectionFailure })))
        .toEqual({ kind: "account_unusable" });
    }
    // The catch-all reason without (or with another) selection failure: env routing, project auth, an incompatible
    // binding, a membership 403, DB or credential I/O. None of them proves the account itself is gone.
    for (const configurationIncomplete of [
      { reason: "ai_connection_unavailable" },
      { reason: "ai_connection_unavailable", selectionFailure: "ai_connection_incompatible" },
      { reason: "ai_connection_unavailable", selectionFailure: "ai_connection_credential_not_shared" },
      { reason: "ai_connection_unavailable", selectionFailure: "ai_connection_responsible_user_missing" },
      { reason: "ai_connection_changed" },
      { reason: "missing_binding" },
    ]) {
      expect(classifyFallbackFailure(configurationFailure(configurationIncomplete))).toBeNull();
    }
  });

  it("leaves an ordinary adapter crash and agent prose unclassified", () => {
    const prose = [
      "OpenCode exited with code 1",
      "TypeError: Cannot read properties of undefined (reading 'map')",
      "The model attempted to run a command that is not allowed in this workspace",
      "git push failed: 403 Forbidden",
      "The selected model is not available right now, please retry",
      "Tool use with this model is not supported",
      "model temporarily not available",
      "The model gpt-4 not supported here so I used another approach",
      "The Stripe call failed with invalid api key, so I stopped",
      "authentication_error from the GitHub API while pushing",
      "Reconnect or validate the selected AI account",
      "Error: model_not_found in the user's config",
      null,
    ];
    for (const runnerProfileJson of [opencodeFallback, claudeFallback]) {
      for (const error of prose) expect(classifyFallbackFailure(failed({ runnerProfileJson, error }))).toBeNull();
    }
    // Claude's error line is the CLI's final result text: OpenCode's signature there is prose, not a provider error.
    expect(classifyFallbackFailure(failed({ runnerProfileJson: claudeFallback, error: OPENCODE_MODEL_DISABLED }))).toBeNull();
  });

  it("leaves quota and transient failures to their own paths", () => {
    expect(classifyFallbackFailure(failed({ errorCode: "provider_quota", error: OPENCODE_MODEL_DISABLED }))).toBeNull();
    expect(classifyFallbackFailure(failed({ error: OPENCODE_MODEL_DISABLED, resultJson: { errorFamily: "transient_upstream" } })))
      .toBeNull();
    for (const errorCode of ["claude_transient_upstream", "codex_transient_upstream", "codex_harness_crash"]) {
      expect(classifyFallbackFailure(failed({ errorCode, error: OPENCODE_MODEL_DISABLED }))).toBeNull();
    }
  });

  it("never classifies a run on the default connection or without a dispatch record", () => {
    expect(classifyFallbackFailure(failed({ error: OPENCODE_MODEL_DISABLED, runnerProfileJson: defaultDispatch }))).toBeNull();
    expect(classifyFallbackFailure(failed({ errorCode: "claude_auth_required", runnerProfileJson: defaultDispatch }))).toBeNull();
    expect(classifyFallbackFailure(failed({ error: OPENCODE_MODEL_DISABLED, runnerProfileJson: {} }))).toBeNull();
    expect(classifyFallbackFailure(failed({ error: OPENCODE_MODEL_DISABLED, runnerProfileJson: null }))).toBeNull();
  });
});
