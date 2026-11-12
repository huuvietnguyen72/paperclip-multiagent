import { describe, expect, it } from "vitest";
import { MODEL_FALLBACK_CARRY_KEYS } from "@paperclipai/shared";
import { connectionLabel, formatRemaining, swapDefault } from "./format";

describe("model fallback format", () => {
  it("formatRemaining hours and minutes", () => {
    const now = new Date("2026-11-12T10:00:00Z");
    expect(formatRemaining(new Date(now.getTime() + (5 * 60 + 28) * 60_000), now)).toBe("còn 5g 28p");
    expect(formatRemaining(new Date(now.getTime() + 12 * 60_000), now)).toBe("còn 12p");
  });

  it("formatRemaining under a minute", () => {
    const now = new Date("2026-11-12T10:00:00Z");
    expect(formatRemaining(new Date(now.getTime() + 30_000), now)).toBe("còn <1p");
  });

  it("connectionLabel prettifies opencode model", () => {
    expect(connectionLabel("opencode_local", "opencode-go/glm-5.3")).toBe("OpenCode Go · GLM 5.3");
  });

  it("swapDefault moves old default into the chosen slot", () => {
    const glm = {
      id: "11111111-1111-4111-8111-111111111111",
      adapterType: "opencode_local",
      adapterConfig: { model: "opencode-go/glm-5.3" },
    };
    const deepseek = {
      id: "22222222-2222-4222-8222-222222222222",
      adapterType: "opencode_local",
      adapterConfig: { model: "opencode-go/deepseek" },
    };
    const agent = {
      adapterType: "claude_local",
      adapterConfig: { model: "claude-sonnet-4-6", cwd: "/work", env: { A: "1" }, timeoutSec: 60 },
      runtimeConfig: {
        enabled: true,
        modelFallback: { enabled: true, connections: [glm, deepseek], noResetWaitMinutes: 30 },
      },
    };
    const out = swapDefault(agent as never, deepseek.id);
    expect(out.adapterType).toBe("opencode_local");
    expect(out.adapterConfig.model).toBe("opencode-go/deepseek");
    expect(out.adapterConfig.cwd).toBe("/work");
    expect(out.adapterConfig.env).toEqual({ A: "1" });
    const mf = out.runtimeConfig.modelFallback as {
      connections: Array<Record<string, any>>;
      noResetWaitMinutes: number;
    };
    expect(mf.noResetWaitMinutes).toBe(30);
    expect(mf.connections).toHaveLength(2);
    expect(mf.connections[0]).toEqual(glm);
    expect(mf.connections[1].id).not.toBe(deepseek.id);
    expect(mf.connections[1].adapterType).toBe("claude_local");
    expect(mf.connections[1].adapterConfig).toEqual({ model: "claude-sonnet-4-6" });
    for (const key of MODEL_FALLBACK_CARRY_KEYS) expect(key in mf.connections[1].adapterConfig).toBe(false);
    expect(out.runtimeConfig.enabled).toBe(true);
  });
});
