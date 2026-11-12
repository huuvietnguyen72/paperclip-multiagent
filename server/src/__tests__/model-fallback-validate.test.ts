import { describe, expect, it } from "vitest";
import { validateModelFallbackPatch } from "../services/model-fallback/validate.js";

const id = "11111111-1111-4111-8111-111111111111";
const conn = (over: Record<string, unknown> = {}) => ({ id, adapterType: "codex_local", adapterConfig: { model: "gpt-5" }, ...over }) as never;

describe("validateModelFallbackPatch", () => {
  it("accepts absent or valid config", () => {
    expect(validateModelFallbackPatch({ modelFallback: undefined, adapterType: "claude_local" })).toBeNull();
    expect(validateModelFallbackPatch({ modelFallback: { enabled: true, connections: [conn()] }, adapterType: "claude_local" })).toBeNull();
  });
  it("rejects unsupported adapter types", () => {
    expect(validateModelFallbackPatch({ modelFallback: { enabled: true, connections: [conn({ adapterType: "paperclip_runner" })] }, adapterType: "claude_local" })).toMatch(/not supported/);
  });
  it("rejects an incompatible binding", () => {
    const aiConnection = { provider: "anthropic", method: "api_key", mode: "responsible_user" };
    expect(validateModelFallbackPatch({ modelFallback: { enabled: true, connections: [conn({ adapterType: "opencode_local", adapterConfig: { model: "x/y" }, aiConnection })] }, adapterType: "claude_local" })).toMatch(/not compatible/);
  });
  it("rejects enabled fallback on a paperclip_runner agent but allows disabled", () => {
    expect(validateModelFallbackPatch({ modelFallback: { enabled: true, connections: [] }, adapterType: "paperclip_runner" })).toMatch(/Paperclip runner/);
    expect(validateModelFallbackPatch({ modelFallback: { enabled: false, connections: [] }, adapterType: "paperclip_runner" })).toBeNull();
  });
});
