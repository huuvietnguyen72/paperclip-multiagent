import { describe, expect, it } from "vitest";
import {
  accountUnusableKey, buildChain, connectionExhaustedUntil, effectiveRunAgent, exhaustionKeys, modelScopedKey, selectConnection,
  type ChainEntry,
} from "./policy.js";

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

  it("an unresolvable default key never triggers a switch (ruling P10)", () => {
    expect(select({ accountKeys: [null, "ai:b", "ai:c"] })).toEqual({ index: 0, kind: "default" });
  });

  it("an unresolvable default key still counts as usable for the return", () => {
    expect(select({ accountKeys: [null, "ai:b", "ai:c"], activeConnectionId: "b", pinnedFinished: true }))
      .toEqual({ index: 0, kind: "return" });
  });

  it("an unresolvable fallback key is still skipped when choosing a fallback", () => {
    expect(select({ accountKeys: ["ai:a", null, "ai:c"], exhaustedUntil: new Map([["ai:a", later(1)]]) }))
      .toEqual({ index: 2, kind: "switch" });
  });
});

describe("model-scoped unusable keys", () => {
  // Two fallbacks on the same OpenCode Go login: GLM is switched off by the provider, DeepSeek still works.
  const opencode = (id: string, model: string): ChainEntry =>
    ({ id, adapterType: "opencode_local", adapterConfig: { model }, aiConnection: null });
  const sameAccountChain = [entry("default"), opencode("glm", "opencode-go/glm-5.3"), opencode("deepseek", "opencode-go/deepseek-v4")];
  const keys = ["ai:a", "login:opencode_local", "login:opencode_local"];
  const glmOut = modelScopedKey("login:opencode_local", "opencode-go/glm-5.3");

  it("builds <accountKey>#model:<model>", () => {
    expect(glmOut).toBe("login:opencode_local#model:opencode-go/glm-5.3");
  });

  it("builds <accountKey>#unusable, separate from the account's quota exhaustion key", () => {
    expect(accountUnusableKey("login:opencode_local")).toBe("login:opencode_local#unusable");
  });

  it("lists account, unusable-account and model keys for the exhaustion lookup", () => {
    expect(exhaustionKeys(sameAccountChain, keys)).toEqual([
      "ai:a", "ai:a#unusable", "ai:a#model:default",
      "login:opencode_local", "login:opencode_local#unusable", glmOut, "login:opencode_local#model:opencode-go/deepseek-v4",
    ]);
    expect(exhaustionKeys(sameAccountChain, [null, null, "login:opencode_local"])).toEqual([
      "login:opencode_local", "login:opencode_local#unusable", "login:opencode_local#model:opencode-go/deepseek-v4",
    ]);
  });

  it("the default ignores unusable marks on its own account and model; only exhaustion counts (ruling P10)", () => {
    // Another agent's fallback failure marked this agent's default account and model unusable.
    const marks = new Map([["ai:a#unusable", later(1)], ["ai:a#model:default", later(1)]]);
    expect(selectConnection({ chain: sameAccountChain, accountKeys: keys, exhaustedUntil: marks, activeConnectionId: null,
      pinnedFinished: false, now })).toEqual({ index: 0, kind: "default" });
    expect(selectConnection({ chain: sameAccountChain, accountKeys: keys, exhaustedUntil: marks, activeConnectionId: "glm",
      pinnedFinished: true, now })).toEqual({ index: 0, kind: "return" });
    expect(connectionExhaustedUntil(sameAccountChain[0]!, "ai:a", marks, true)).toBeUndefined();
    // Quota exhaustion still makes the default unusable, exactly as before.
    expect(selectConnection({ chain: sameAccountChain, accountKeys: keys, exhaustedUntil: new Map([["ai:a", later(1)]]),
      activeConnectionId: null, pinnedFinished: false, now })).toEqual({ index: 1, kind: "switch" });
  });

  it("the same account as a fallback tier honours both unusable marks", () => {
    const sharedAccount = [entry("default"), { ...entry("b"), adapterConfig: { model: "default" } }];
    const both = ["ai:a", "ai:a"];
    expect(selectConnection({ chain: sharedAccount, accountKeys: both, exhaustedUntil: new Map([["ai:a#unusable", later(1)]]),
      activeConnectionId: "b", pinnedFinished: false, now })).toEqual({ index: 0, kind: "switch" });
    expect(selectConnection({ chain: sharedAccount, accountKeys: both, exhaustedUntil: new Map([["ai:a#model:default", later(1)]]),
      activeConnectionId: "b", pinnedFinished: false, now })).toEqual({ index: 0, kind: "switch" });
  });

  it("an unusable model blocks only that model; another model on the same account stays usable", () => {
    const exhaustedUntil = new Map([["ai:a", later(1)], [glmOut, later(2)]]);
    expect(selectConnection({ chain: sameAccountChain, accountKeys: keys, exhaustedUntil, activeConnectionId: null,
      pinnedFinished: false, now })).toEqual({ index: 2, kind: "switch" });
  });

  it("an agent already on the unusable model moves on even with its task pinned", () => {
    const exhaustedUntil = new Map([["ai:a", later(1)], [glmOut, later(2)]]);
    expect(selectConnection({ chain: sameAccountChain, accountKeys: keys, exhaustedUntil, activeConnectionId: "glm",
      pinnedFinished: false, now })).toEqual({ index: 2, kind: "switch" });
  });

  it("the model key expires like an account exhaustion", () => {
    const exhaustedUntil = new Map([["ai:a", later(1)], [glmOut, later(-1)]]);
    expect(selectConnection({ chain: sameAccountChain, accountKeys: keys, exhaustedUntil, activeConnectionId: "glm",
      pinnedFinished: false, now })).toEqual({ index: 1, kind: "stay" });
  });

  it("an unusable account blocks every model on it", () => {
    const exhaustedUntil = new Map([[accountUnusableKey("login:opencode_local"), later(1)]]);
    expect(selectConnection({ chain: sameAccountChain, accountKeys: keys, exhaustedUntil, activeConnectionId: "glm",
      pinnedFinished: false, now })).toEqual({ index: 0, kind: "switch" });
  });

  it("all unusable waits for the tier that frees up first, counting the later of its two keys", () => {
    const exhaustedUntil = new Map([
      ["ai:a", later(5)],
      ["login:opencode_local", later(1)],
      [glmOut, later(4)],
    ]);
    expect(selectConnection({ chain: sameAccountChain, accountKeys: keys, exhaustedUntil, activeConnectionId: null,
      pinnedFinished: false, now })).toEqual({ index: 2, kind: "all_exhausted" });
    expect(connectionExhaustedUntil(sameAccountChain[1]!, keys[1]!, exhaustedUntil)).toEqual(later(4));
    expect(connectionExhaustedUntil(sameAccountChain[2]!, keys[2]!, exhaustedUntil)).toEqual(later(1));
    expect(connectionExhaustedUntil(sameAccountChain[2]!, null, exhaustedUntil)).toBeUndefined();
  });
});
