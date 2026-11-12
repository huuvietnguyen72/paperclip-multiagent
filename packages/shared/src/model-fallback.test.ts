import { describe, expect, it } from "vitest";
import { modelFallbackConfigSchema } from "./model-fallback.js";
import { agentRuntimeConfigSchema } from "./validators/agent.js";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const conn = (n: number, config: Record<string, unknown> = { model: "opencode-go/glm-5.3" }) => ({
  id: uuid(n),
  adapterType: "opencode_local",
  adapterConfig: config,
});

describe("model fallback contracts", () => {
  it("accepts a chain with an opencode fallback", () => {
    const parsed = modelFallbackConfigSchema.parse({ enabled: true, connections: [conn(1)] });
    expect(parsed.connections[0]?.adapterType).toBe("opencode_local");
  });

  it("rejects more than 10 connections", () => {
    const connections = Array.from({ length: 11 }, (_, i) => conn(i + 1));
    expect(modelFallbackConfigSchema.safeParse({ enabled: true, connections }).success).toBe(false);
  });

  it("rejects a connection without adapterConfig.model", () => {
    expect(modelFallbackConfigSchema.safeParse({ enabled: true, connections: [conn(1, {})] }).success).toBe(false);
    expect(modelFallbackConfigSchema.safeParse({ enabled: true, connections: [conn(1, { model: " " })] }).success).toBe(false);
  });

  it("rejects duplicate connection ids", () => {
    expect(modelFallbackConfigSchema.safeParse({ enabled: true, connections: [conn(1), conn(1)] }).success).toBe(false);
  });

  it("agentRuntimeConfigSchema keeps modelFallback", () => {
    const modelFallback = { enabled: true, connections: [conn(1)], noResetWaitMinutes: 30 };
    expect(agentRuntimeConfigSchema.parse({ modelFallback })).toEqual({ modelFallback });
  });
});
