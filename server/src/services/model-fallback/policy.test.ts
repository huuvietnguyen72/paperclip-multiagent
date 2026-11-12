import { describe, expect, it } from "vitest";
import { buildChain, effectiveRunAgent, selectConnection, type ChainEntry } from "./policy.js";

const CONN_B = "11111111-1111-4111-8111-111111111111";

function entry(id: string): ChainEntry {
  return { id, adapterType: "claude_local", adapterConfig: { model: id }, aiConnection: null };
}

const chain = [entry("default"), entry("b"), entry("c")];
const now = new Date("2026-11-12T12:00:00Z");
const later = (h: number) => new Date(now.getTime() + h * 3600_000);

function select(overrides: Partial<Parameters<typeof selectConnection>[0]> = {}) {
  return selectConnection({
    chain,
    accountKeys: ["ai:a", "ai:b", "ai:c"],
    exhaustedUntil: new Map(),
    activeConnectionId: null,
    pinnedFinished: false,
    now,
    ...overrides,
  });
}

describe("buildChain", () => {
  it("no fallback config returns only default", () => {
    const result = buildChain({ adapterType: "claude_local", adapterConfig: {}, runtimeConfig: {} });
    expect(result.length).toBe(1);
    expect(result[0].id).toBe("default");
  });

  it("disabled config returns only default", () => {
    const result = buildChain({
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {
        modelFallback: {
          enabled: false,
          connections: [{ id: CONN_B, adapterType: "opencode_local", adapterConfig: { model: "x/y" } }],
        },
      },
    });
    expect(result.length).toBe(1);
  });

  it("paperclip_runner agent gets a default-only chain even with a configured chain (ruling P8)", () => {
    const result = buildChain({
      adapterType: "paperclip_runner",
      adapterConfig: {},
      runtimeConfig: {
        modelFallback: {
          enabled: true,
          connections: [{ id: CONN_B, adapterType: "opencode_local", adapterConfig: { model: "x/y" } }],
        },
      },
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: "default", adapterType: "paperclip_runner" });
  });
});

describe("effectiveRunAgent", () => {
  it("carries instructions and swaps model", () => {
    const agent = {
      adapterType: "claude_local",
      adapterConfig: {
        instructionsFilePath: "/i.md",
        model: "claude-sonnet-5-5",
        dangerouslySkipPermissions: true,
      },
      runtimeConfig: { aiConnection: { connectionId: "x" } },
    };
    const result = effectiveRunAgent(agent, {
      id: CONN_B,
      adapterType: "opencode_local",
      adapterConfig: { model: "opencode-go/glm-5.3" },
      aiConnection: null,
    });
    expect(result.adapterType).toBe("opencode_local");
    expect(result.adapterConfig).toEqual({ instructionsFilePath: "/i.md", model: "opencode-go/glm-5.3" });
    expect((result.runtimeConfig as Record<string, unknown>).aiConnection).toBeUndefined();
    expect(agent.adapterType).toBe("claude_local");
  });
});

describe("selectConnection", () => {
  it("default usable stays on default", () => {
    expect(select()).toEqual({ index: 0, kind: "default" });
  });

  it("default exhausted switches to first usable", () => {
    expect(select({ exhaustedUntil: new Map([["ai:a", later(1)]]) })).toEqual({ index: 1, kind: "switch" });
  });

  it("skips every exhausted account in order", () => {
    const exhaustedUntil = new Map([
      ["ai:a", later(1)],
      ["ai:b", later(2)],
    ]);
    expect(select({ exhaustedUntil })).toEqual({ index: 2, kind: "switch" });
  });

  it("stays on fallback while pinned unfinished", () => {
    expect(select({ activeConnectionId: "b", pinnedFinished: false })).toEqual({ index: 1, kind: "stay" });
  });

  it("returns when pinned finished and default reset", () => {
    expect(select({ activeConnectionId: "b", pinnedFinished: true })).toEqual({ index: 0, kind: "return" });
  });

  it("does not return while default still exhausted", () => {
    expect(
      select({
        activeConnectionId: "b",
        pinnedFinished: true,
        exhaustedUntil: new Map([["ai:a", later(1)]]),
      }),
    ).toEqual({ index: 1, kind: "stay" });
  });

  it("fallback exhausted returns to reset default", () => {
    expect(
      select({
        activeConnectionId: "b",
        pinnedFinished: false,
        exhaustedUntil: new Map([["ai:b", later(1)]]),
      }),
    ).toEqual({ index: 0, kind: "switch" });
  });

  it("all exhausted picks earliest reset", () => {
    const exhaustedUntil = new Map([
      ["ai:a", new Date("2026-11-12T20:00:00Z")],
      ["ai:b", new Date("2026-11-12T18:00:00Z")],
      ["ai:c", new Date("2026-11-12T22:00:00Z")],
    ]);
    expect(select({ exhaustedUntil })).toEqual({ index: 1, kind: "all_exhausted" });
  });

  it("stale active id resolves to default", () => {
    expect(select({ activeConnectionId: "gone" })).toEqual({ index: 0, kind: "default" });
  });
});
