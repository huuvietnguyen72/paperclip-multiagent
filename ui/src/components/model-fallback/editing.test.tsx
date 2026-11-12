// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent, AgentModelFallbackView } from "@paperclipai/shared";
import { swapDefault } from "@/lib/model-fallback/format";
import { effortLevelsFor, reorderBody } from "@/lib/model-fallback/edit";
import { ModelFallbackEditor } from "./ModelFallbackEditor";

const FALLBACK_ID = "11111111-1111-4111-8111-111111111111";
const NEW_ID = "22222222-2222-4222-8222-222222222222";

const mockApi = vi.hoisted(() => ({ agentView: vi.fn() }));
const agentsMock = vi.hoisted(() => ({ update: vi.fn(), adapterModels: vi.fn(), testEnvironment: vi.fn(), getConfiguration: vi.fn() }));
vi.mock("@/api/model-fallback", () => ({ modelFallbackApi: mockApi }));
vi.mock("@/api/agents", () => ({ agentsApi: agentsMock }));
vi.mock("@/lib/uuid", () => ({ createUuid: () => "22222222-2222-4222-8222-222222222222" }));
vi.mock("@/components/ai-connections/AiConnectionField", () => ({ AiConnectionField: () => null }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

async function waitFor(assertion: () => void, attempts = 20) {
  let lastError: unknown;
  for (let index = 0; index < attempts; index += 1) {
    await flushReact();
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

const agent = {
  id: "agent-1",
  name: "Minh",
  role: "engineer",
  adapterType: "claude_local",
  adapterConfig: { model: "claude-sonnet-5-5", cwd: "/work", effort: "high" },
  runtimeConfig: {
    modelFallback: {
      enabled: true,
      connections: [{ id: FALLBACK_ID, adapterType: "opencode_local", adapterConfig: { model: "opencode-go/glm-5.3" } }],
    },
  },
} as unknown as Agent;

function view(): AgentModelFallbackView {
  return {
    enabled: true,
    noResetWaitMinutes: 30,
    active: { connectionId: "default", since: null, reason: null },
    pinnedIssues: [],
    connections: [
      {
        id: "default", position: 1, isDefault: true, adapterType: "claude_local", model: "claude-sonnet-5-5",
        aiConnection: null, accountKey: null, accountLabel: "Claude chính", exhaustedUntil: null,
        inUse: true, lastUsedAt: null, runsToday: 0, tokensToday: 0, quotaWindows: [],
      },
      {
        id: FALLBACK_ID, position: 2, isDefault: false, adapterType: "opencode_local", model: "opencode-go/glm-5.3",
        aiConnection: null, accountKey: null, accountLabel: "OpenCode Go", exhaustedUntil: null,
        inUse: false, lastUsedAt: null, runsToday: 0, tokensToday: 0, quotaWindows: [],
      },
    ],
    today: { switches: 0, tokens: 0 },
    timeline: [],
  };
}

function setSelect(select: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
  setter.call(select, value);
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

function buttonByText(text: string): HTMLButtonElement {
  const scope = document.body.querySelector("[role=dialog]") ?? document.body;
  const found = [...scope.querySelectorAll("button")].find((button) => button.textContent?.includes(text));
  if (!found) throw new Error(`No button with text ${text}`);
  return found as HTMLButtonElement;
}

describe("model fallback editing", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockApi.agentView.mockReset().mockResolvedValue(view());
    agentsMock.update.mockReset().mockResolvedValue({});
    agentsMock.getConfiguration.mockReset().mockResolvedValue({
      adapterType: agent.adapterType,
      adapterConfig: agent.adapterConfig,
      runtimeConfig: agent.runtimeConfig,
      configurationRevision: "rev-1",
    });
    agentsMock.testEnvironment.mockReset().mockResolvedValue({ status: "pass", checks: [] });
    agentsMock.adapterModels.mockReset().mockImplementation(async (_company: string, type: string) =>
      type === "opencode_local"
        ? [
            { id: "opencode-go/deepseek-v4.1-flash", label: "DeepSeek V4.1 Flash" },
            { id: "opencode-go/glm-5.3", label: "GLM 5.3" },
          ]
        : [
            { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
            { id: "claude-opus-5-5", label: "Claude Opus 5.5" },
          ],
    );
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  async function render() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <ModelFallbackEditor agent={agent} companyId="company-1" />
        </QueryClientProvider>,
      );
    });
    await waitFor(() => expect(container.querySelector("[data-testid=connection-default]")).not.toBeNull());
    return root;
  }

  it("editing the default model patches the agent's adapterConfig.model", async () => {
    const root = await render();
    await act(async () => (container.querySelector("[aria-label='Sửa kết nối 1']") as HTMLButtonElement).click());
    await waitFor(() => expect(document.body.querySelector("select[aria-label=Model] option[value='claude-opus-5-5']")).not.toBeNull());
    await act(async () => setSelect(document.body.querySelector("select[aria-label=Model]") as HTMLSelectElement, "claude-opus-5-5"));
    await act(async () => buttonByText("Lưu").click());
    await waitFor(() => expect(agentsMock.update).toHaveBeenCalledTimes(1));
    const [id, body, companyId] = agentsMock.update.mock.calls[0];
    expect(id).toBe("agent-1");
    expect(companyId).toBe("company-1");
    expect(body.adapterConfig).toEqual({ model: "claude-opus-5-5", cwd: "/work", effort: "high" });
    expect(body.adapterType).toBe("claude_local");
    await act(async () => root.unmount());
  });

  it("adding opencode appends a connection", async () => {
    const root = await render();
    await act(async () => buttonByText("Thêm tài khoản / provider").click());
    await act(async () => buttonByText("Dùng tài khoản OpenCode Go").click());
    await waitFor(() => expect(document.body.querySelector("select[aria-label=Model] option[value='opencode-go/deepseek-v4.1-flash']")).not.toBeNull());
    await act(async () => buttonByText("Thêm").click());
    await waitFor(() => expect(agentsMock.update).toHaveBeenCalledTimes(1));
    const body = agentsMock.update.mock.calls[0][1];
    const connections = body.runtimeConfig.modelFallback.connections;
    expect(connections.at(-1)).toEqual({
      id: NEW_ID,
      adapterType: "opencode_local",
      adapterConfig: { model: "opencode-go/deepseek-v4.1-flash" },
    });
    expect(connections).toHaveLength(2);
    await act(async () => root.unmount());
  });

  it("ships the Anthropic-compatible type disabled with the Sắp có tag", async () => {
    const root = await render();
    await act(async () => buttonByText("Thêm tài khoản / provider").click());
    const card = buttonByText("Endpoint tương thích Anthropic");
    expect(card.disabled).toBe(true);
    expect(card.textContent).toContain("Sắp có");
    await act(async () => root.unmount());
  });

  it("set default swaps configs", async () => {
    const root = await render();
    await act(async () => buttonByText("Đặt mặc định").click());
    await waitFor(() => expect(agentsMock.update).toHaveBeenCalledTimes(1));
    const body = agentsMock.update.mock.calls[0][1];
    expect(body).toEqual({ ...swapDefault(agent as never, FALLBACK_ID), replaceAdapterConfig: true, expectedConfigurationRevision: "rev-1" });
    expect(body.adapterType).toBe("opencode_local");
    await act(async () => root.unmount());
  });

  it("dropping a fallback on slot 1 sets it as default", () => {
    expect(reorderBody(agent as never, [FALLBACK_ID, "default"])).toEqual(swapDefault(agent as never, FALLBACK_ID));
  });

  it("delete is hidden for the default", async () => {
    const root = await render();
    await act(async () => (container.querySelector("[aria-label='Sửa kết nối 1']") as HTMLButtonElement).click());
    await waitFor(() => expect(document.body.querySelector("[role=dialog]")).not.toBeNull());
    expect(document.body.textContent).not.toContain("Xoá kết nối");
    await act(async () => buttonByText("Huỷ").click());
    await waitFor(() => expect(document.body.querySelector("[role=dialog]")).toBeNull());
    await act(async () => (container.querySelector("[aria-label='Sửa kết nối 2']") as HTMLButtonElement).click());
    await waitFor(() => expect(document.body.textContent).toContain("Xoá kết nối"));
    await act(async () => root.unmount());
  });

  it("settings toggle patches enabled false", async () => {
    const root = await render();
    await act(async () => buttonByText("Cài đặt chuyển đổi").click());
    await waitFor(() => expect(document.body.querySelector("[role=switch]")).not.toBeNull());
    await act(async () => (document.body.querySelector("[role=switch]") as HTMLButtonElement).click());
    await act(async () => buttonByText("Lưu").click());
    await waitFor(() => expect(agentsMock.update).toHaveBeenCalledTimes(1));
    expect(agentsMock.update.mock.calls[0][1].runtimeConfig.modelFallback.enabled).toBe(false);
    await act(async () => root.unmount());
  });

  it("clearing effort on the default sends no effort, replaceAdapterConfig and the revision", async () => {
    const root = await render();
    await act(async () => (container.querySelector("[aria-label='Sửa kết nối 1']") as HTMLButtonElement).click());
    await waitFor(() => expect(document.body.querySelector("select[aria-label='Thinking effort']")).not.toBeNull());
    await act(async () => setSelect(document.body.querySelector("select[aria-label='Thinking effort']") as HTMLSelectElement, ""));
    await act(async () => buttonByText("Lưu").click());
    await waitFor(() => expect(agentsMock.update).toHaveBeenCalledTimes(1));
    const body = agentsMock.update.mock.calls[0][1];
    expect(body.adapterConfig).toEqual({ model: "claude-sonnet-5-5", cwd: "/work" });
    expect(body.replaceAdapterConfig).toBe(true);
    expect(body.expectedConfigurationRevision).toBe("rev-1");
    await act(async () => root.unmount());
  });

  it("set default replaces the adapterConfig and sends the revision", async () => {
    const root = await render();
    await act(async () => buttonByText("Đặt mặc định").click());
    await waitFor(() => expect(agentsMock.update).toHaveBeenCalledTimes(1));
    const body = agentsMock.update.mock.calls[0][1];
    expect(body.replaceAdapterConfig).toBe(true);
    expect(body.expectedConfigurationRevision).toBe("rev-1");
    await act(async () => root.unmount());
  });

  it("opencode offers the variant levels and saves variant", async () => {
    const root = await render();
    await act(async () => (container.querySelector("[aria-label='Sửa kết nối 2']") as HTMLButtonElement).click());
    await waitFor(() => expect(document.body.querySelector("select[aria-label='Thinking effort'] option[value=xhigh]")).not.toBeNull());
    expect(document.body.querySelector("select[aria-label='Thinking effort'] option[value=max]")).not.toBeNull();
    await act(async () => setSelect(document.body.querySelector("select[aria-label='Thinking effort']") as HTMLSelectElement, "xhigh"));
    await act(async () => buttonByText("Lưu").click());
    await waitFor(() => expect(agentsMock.update).toHaveBeenCalledTimes(1));
    const body = agentsMock.update.mock.calls[0][1];
    expect(body.runtimeConfig.modelFallback.connections[0].adapterConfig).toEqual({ model: "opencode-go/glm-5.3", variant: "xhigh" });
    expect(body.adapterConfig).toBeUndefined();
    expect(body.replaceAdapterConfig).toBeUndefined();
    await act(async () => root.unmount());
  });

  it("codex effort levels follow the adapter's per-model list (ultra only where the model supports it)", () => {
    expect(effortLevelsFor("codex_local", "gpt-5.5")).toEqual(["minimal", "low", "medium", "high", "xhigh"]);
    expect(effortLevelsFor("codex_local", "gpt-6-luna")).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(effortLevelsFor("codex_local", "gpt-6.1-sol")).toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
    expect(effortLevelsFor("codex_local", "")).not.toContain("ultra");
    expect(effortLevelsFor("claude_local", "claude-sonnet-5-5")).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(effortLevelsFor("opencode_local", "opencode-go/glm-5.3")).not.toContain("ultra");
  });

  it("reorder keeps the order after slot 1 and never drops connections", () => {
    const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const two = {
      adapterType: "claude_local",
      adapterConfig: { model: "m" },
      runtimeConfig: {
        modelFallback: {
          enabled: true,
          connections: [
            { id: A, adapterType: "opencode_local", adapterConfig: { model: "a" } },
            { id: B, adapterType: "codex_local", adapterConfig: { model: "b" } },
          ],
        },
      },
    };
    const ids = (body: { runtimeConfig: Record<string, unknown> }) =>
      (body.runtimeConfig.modelFallback as { connections: Array<{ id: string; adapterType: string }> }).connections;
    // [B, default, A]: B becomes default, old default (new id) stays at slot 2, A at slot 3.
    const first = reorderBody(two as never, [B, "default", A]);
    expect(first.adapterType).toBe("codex_local");
    expect(ids(first).map((c) => c.id)).toEqual([NEW_ID, A]);
    expect(ids(first)[0].adapterType).toBe("claude_local");
    // Default dragged to slot 3: [A, B, default] -> A default, then B, then old default.
    const second = reorderBody(two as never, [A, B, "default"]);
    expect(second.adapterType).toBe("opencode_local");
    expect(ids(second).map((c) => c.id)).toEqual([B, NEW_ID]);
    // Missing ids are appended, not dropped.
    const third = reorderBody(two as never, ["default", B]);
    expect(ids(third).map((c) => c.id)).toEqual([B, A]);
  });

  it("shows the server message when the save is rejected", async () => {
    agentsMock.update.mockRejectedValue(new Error("adapterConfig.model must be a non-empty string"));
    const root = await render();
    await act(async () => (container.querySelector("[aria-label='Sửa kết nối 1']") as HTMLButtonElement).click());
    await act(async () => buttonByText("Lưu").click());
    await waitFor(() => expect(document.body.querySelector("[role=alert]")?.textContent).toContain("must be a non-empty string"));
    await act(async () => root.unmount());
  });
});
