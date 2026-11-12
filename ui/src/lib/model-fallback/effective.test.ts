import { describe, expect, it } from "vitest";
import { effectiveModelFor, fallbackActiveMap, fallbackActiveUnknown } from "./effective";

const agent = { id: "a", adapterType: "claude_local", adapterConfig: { model: "claude-sonnet-5-5" } };

describe("effectiveModelFor", () => {
  it("uses the configured adapter and model by default", () => {
    expect(effectiveModelFor(agent, undefined)).toEqual({ adapterType: "claude_local", model: "claude-sonnet-5-5", isFallback: false });
  });
  it("uses the active fallback connection", () => {
    const map = fallbackActiveMap([{ agentId: "a", connectionId: "c", adapterType: "codex_local", model: "gpt-5.5", isFallback: true }]);
    expect(effectiveModelFor(agent, map)).toEqual({ adapterType: "codex_local", model: "gpt-5.5", isFallback: true });
  });
  it("ignores an active entry that is not a fallback", () => {
    const map = fallbackActiveMap([{ agentId: "a", connectionId: "default", adapterType: "claude_local", model: "x", isFallback: false }]);
    expect(effectiveModelFor(agent, map).isFallback).toBe(false);
    expect(effectiveModelFor(agent, map).model).toBe("claude-sonnet-5-5");
  });
});

describe("fallbackActiveUnknown", () => {
  const chain = { enabled: true, connections: [{ id: "c", adapterType: "codex_local", adapterConfig: { model: "gpt-5.5" } }] };
  const chained = { ...agent, runtimeConfig: { modelFallback: chain } };
  it("is unknown only when the active query failed for an agent with an enabled chain", () => {
    expect(fallbackActiveUnknown(chained, true)).toBe(true);
    expect(fallbackActiveUnknown(chained, false)).toBe(false);
    expect(fallbackActiveUnknown(agent, true)).toBe(false);
    expect(fallbackActiveUnknown({ ...agent, runtimeConfig: { modelFallback: { ...chain, enabled: false } } }, true)).toBe(false);
    expect(fallbackActiveUnknown({ ...chained, adapterType: "paperclip_runner" }, true)).toBe(false);
  });
});
