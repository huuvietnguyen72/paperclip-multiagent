import { describe, expect, it } from "vitest";
import { modelBadgeFor } from "./model-badge";

describe("modelBadgeFor", () => {
  it("prettifies Claude model ids and uses the Claude mark", () => {
    expect(modelBadgeFor("claude_local", "claude-opus-5-5")).toEqual({ label: "Opus 5.5", markType: "claude_local" });
    expect(modelBadgeFor("claude_local", "claude-sonnet-5-5")).toEqual({ label: "Sonnet 5.5", markType: "claude_local" });
  });

  it("uses the OpenAI/Codex mark for GPT models", () => {
    expect(modelBadgeFor("codex_local", "gpt-6.1-sol")).toEqual({ label: "GPT-6.1 Sol", markType: "codex_local" });
  });

  it("strips provider prefixes and picks the mark by model family", () => {
    expect(modelBadgeFor("opencode_local", "opencode-go/kimi-k3")).toEqual({ label: "Kimi K3", markType: "kimi_local" });
    expect(modelBadgeFor("claude_local", "gemini-3-pro").markType).toBe("gemini_local");
    expect(modelBadgeFor("opencode_local", "xai/grok-5").markType).toBe("grok_local");
  });

  it("falls back to the adapter mark for families without a logo", () => {
    expect(modelBadgeFor("opencode_local", "opencode-go/glm-5.3")).toEqual({ label: "GLM-5.3", markType: "opencode_local" });
    expect(modelBadgeFor("opencode_local", "opencode-go/qwen3.8-max")).toEqual({ label: "Qwen3.8 Max", markType: "opencode_local" });
  });

  it("prefers the adapter's own model label when known", () => {
    const labels = new Map([["claude-opus-5-5", "Claude Opus 5.5"]]);
    expect(modelBadgeFor("claude_local", "claude-opus-5-5", labels).label).toBe("Claude Opus 5.5");
  });

  it("prettifies when the adapter label is just the raw id", () => {
    const labels = new Map([["gpt-6.1-sol", "gpt-6.1-sol"]]);
    expect(modelBadgeFor("codex_local", "gpt-6.1-sol", labels).label).toBe("GPT-6.1 Sol");
  });

  it("shows the adapter display name when no model is set", () => {
    expect(modelBadgeFor("codex_local", "")).toEqual({ label: "Codex", markType: "codex_local" });
    expect(modelBadgeFor("claude_local", null)).toEqual({ label: "Claude Code", markType: "claude_local" });
  });
});
