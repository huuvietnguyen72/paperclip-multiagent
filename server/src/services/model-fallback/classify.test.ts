import { describe, expect, it } from "vitest";
import { classifyFallbackFailure } from "./classify.js";

// The real failure text of the 2026-11-16 incident (workspace id shortened).
const OPENCODE_MODEL_DISABLED = "Model access is disabled. Change model access at https://opencode.ai/console/wrk_01J/models.";

const fallbackDispatch = {
  adapterDispatch: {
    adapterType: "opencode_local",
    modelFallback: {
      connectionId: "22222222-2222-4222-8222-222222222222", accountKey: "login:opencode_local",
      adapterType: "opencode_local", model: "opencode-go/glm-5.3", isFallback: true, kind: "switch",
    },
  },
};
const defaultDispatch = {
  adapterDispatch: {
    adapterType: "claude_local",
    modelFallback: {
      connectionId: "default", accountKey: "ai:own", adapterType: "claude_local", model: "claude-sonnet-5-5", isFallback: false,
    },
  },
};

type RunPatch = { errorCode?: string | null; error?: string | null; resultJson?: unknown; runnerProfileJson?: unknown };
function failed(patch: RunPatch = {}) {
  return { errorCode: "adapter_failed", error: null, resultJson: null, runnerProfileJson: fallbackDispatch, ...patch };
}

describe("classifyFallbackFailure", () => {
  it("classifies the real OpenCode 'Model access is disabled' failure as model_unusable", () => {
    expect(classifyFallbackFailure(failed({ error: OPENCODE_MODEL_DISABLED }))).toEqual({ kind: "model_unusable" });
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

  it("classifies authentication and revoked-account failures as account_unusable", () => {
    expect(classifyFallbackFailure(failed({ errorCode: "claude_auth_required", error: "Please run /login" })))
      .toEqual({ kind: "account_unusable" });
    expect(classifyFallbackFailure(failed({
      errorCode: "configuration_incomplete",
      error: "Reconnect or validate the selected AI account",
      resultJson: { configurationIncomplete: { reason: "ai_connection_unavailable" } },
    }))).toEqual({ kind: "account_unusable" });
    expect(classifyFallbackFailure(failed({ error: "Reconnect or validate the selected AI account" })))
      .toEqual({ kind: "account_unusable" });
    expect(classifyFallbackFailure(failed({ errorCode: "codex_failed", resultJson: { errorFamily: "refresh_token_expired" } })))
      .toEqual({ kind: "account_unusable" });
  });

  it("classifies a model the provider cannot find as model_unusable", () => {
    expect(classifyFallbackFailure(failed({ errorCode: "model_not_found", error: "model missing" }))).toEqual({ kind: "model_unusable" });
    expect(classifyFallbackFailure(failed({ error: "ProviderModelNotFoundError: opencode-go/glm-9" }))).toEqual({ kind: "model_unusable" });
    expect(classifyFallbackFailure(failed({ error: "The model `opencode-go/glm-9` is not available for this account" })))
      .toEqual({ kind: "model_unusable" });
  });

  it("leaves an ordinary adapter crash unclassified", () => {
    for (const error of [
      "OpenCode exited with code 1",
      "TypeError: Cannot read properties of undefined (reading 'map')",
      "The model attempted to run a command that is not allowed in this workspace",
      "git push failed: 403 Forbidden",
      null,
    ]) {
      expect(classifyFallbackFailure(failed({ error }))).toBeNull();
    }
    // A configuration gap that is not the AI account stays with its owner.
    expect(classifyFallbackFailure(failed({
      errorCode: "configuration_incomplete", error: "missing credential",
      resultJson: { configurationIncomplete: { reason: "missing_binding" } },
    }))).toBeNull();
  });

  it("leaves quota and transient failures to their own paths", () => {
    expect(classifyFallbackFailure(failed({ errorCode: "provider_quota", error: OPENCODE_MODEL_DISABLED }))).toBeNull();
    expect(classifyFallbackFailure(failed({ error: OPENCODE_MODEL_DISABLED, resultJson: { errorFamily: "transient_upstream" } })))
      .toBeNull();
  });

  it("never classifies a run on the default connection or without a dispatch record", () => {
    expect(classifyFallbackFailure(failed({ error: OPENCODE_MODEL_DISABLED, runnerProfileJson: defaultDispatch }))).toBeNull();
    expect(classifyFallbackFailure(failed({ errorCode: "claude_auth_required", runnerProfileJson: defaultDispatch }))).toBeNull();
    expect(classifyFallbackFailure(failed({ error: OPENCODE_MODEL_DISABLED, runnerProfileJson: {} }))).toBeNull();
    expect(classifyFallbackFailure(failed({ error: OPENCODE_MODEL_DISABLED, runnerProfileJson: null }))).toBeNull();
  });
});
