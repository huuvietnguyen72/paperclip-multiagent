// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent, AgentModelFallbackView } from "@paperclipai/shared";
import { ModelFallbackTab } from "./ModelFallbackTab";

const mockApi = vi.hoisted(() => ({ agentView: vi.fn() }));
vi.mock("@/api/model-fallback", () => ({ modelFallbackApi: mockApi }));

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

const agent = { id: "agent-1", name: "Minh", adapterType: "claude_local" } as unknown as Agent;

function baseView(overrides: Partial<AgentModelFallbackView> = {}): AgentModelFallbackView {
  const inFiveHours = new Date(Date.now() + ((5 * 60 + 28) * 60 + 30) * 1000).toISOString();
  return {
    enabled: true,
    noResetWaitMinutes: 30,
    active: { connectionId: "glm", since: "2026-11-12T08:00:00.000Z", reason: "quota" },
    pinnedIssues: [{ id: "i1", identifier: "PAP-7", title: "Fix login", status: "in_progress", finished: false }],
    connections: [
      {
        id: "default", position: 0, isDefault: true, adapterType: "claude_local", model: "claude-opus-4-8",
        aiConnection: null, accountKey: null, accountLabel: "Claude chính", exhaustedUntil: inFiveHours,
        inUse: false, lastUsedAt: "2026-11-12T07:00:00.000Z", runsToday: 3, tokensToday: 1000, quotaWindows: [],
      },
      {
        id: "glm", position: 1, isDefault: false, adapterType: "opencode_local", model: "opencode-go/glm-5.3",
        aiConnection: null, accountKey: null, accountLabel: "OpenCode Go", exhaustedUntil: null,
        inUse: true, lastUsedAt: "2026-11-12T08:30:00.000Z", runsToday: 2, tokensToday: 500, quotaWindows: [],
      },
    ],
    today: { switches: 1, tokens: 1500 },
    timeline: [
      { at: "2026-11-12T08:00:00.000Z", kind: "switched", fromModel: "claude-opus-4-8", toModel: "opencode-go/glm-5.3" },
      { at: "2026-11-12T09:00:00.000Z", kind: "run", status: "succeeded", issueIdentifier: "PAP-7", model: "opencode-go/glm-5.3" },
    ],
    ...overrides,
  };
}

describe("ModelFallbackTab", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockApi.agentView.mockReset();
  });

  afterEach(() => {
    container.remove();
  });

  async function render() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <ModelFallbackTab agent={agent} companyId="company-1" />
        </QueryClientProvider>,
      );
    });
    return root;
  }

  it("shows the in-use connection in the header chip", async () => {
    mockApi.agentView.mockResolvedValue(baseView());
    const root = await render();
    await waitFor(() => expect(container.querySelector("[data-testid=live-chip]")).not.toBeNull());
    const chip = container.querySelector("[data-testid=live-chip]")!;
    expect(chip.textContent).toContain("Đang chạy");
    expect(chip.textContent).toContain("GLM 5.3");
    expect(container.textContent).toContain("Dự phòng 1");
    expect(mockApi.agentView).toHaveBeenCalledWith("agent-1", "company-1");
    await act(async () => root.unmount());
  });

  it("chip shows +1 when two connections are in use", async () => {
    const view = baseView();
    view.connections[0] = { ...view.connections[0], inUse: true, exhaustedUntil: null, lastUsedAt: "2026-11-12T06:00:00.000Z" };
    mockApi.agentView.mockResolvedValue(view);
    const root = await render();
    await waitFor(() => expect(container.querySelector("[data-testid=live-chip]")).not.toBeNull());
    const chip = container.querySelector("[data-testid=live-chip]")!;
    expect(chip.textContent).toContain("GLM 5.3");
    expect(chip.textContent).toContain("+1 kết nối khác");
    await act(async () => root.unmount());
  });

  it("marks the exhausted default", async () => {
    mockApi.agentView.mockResolvedValue(baseView());
    const root = await render();
    await waitFor(() => expect(container.querySelector("[data-testid=connection-default]")).not.toBeNull());
    expect(container.querySelector("[data-testid=connection-default]")!.textContent).toContain("Hết token · còn 5g 28p");
    await act(async () => root.unmount());
  });

  it("lists timeline events newest first", async () => {
    mockApi.agentView.mockResolvedValue(baseView());
    const root = await render();
    await waitFor(() => expect(container.querySelectorAll("[data-testid=timeline-event]").length).toBe(2));
    const items = [...container.querySelectorAll("[data-testid=timeline-event]")];
    expect(items[0].getAttribute("data-kind")).toBe("run");
    expect(items[1].getAttribute("data-kind")).toBe("switched");
    await act(async () => root.unmount());
  });

  it("surfaces load errors", async () => {
    mockApi.agentView.mockRejectedValue(new Error("boom"));
    const root = await render();
    await waitFor(() => expect(container.textContent).toContain("Không tải được thông tin kết nối."));
    await act(async () => root.unmount());
  });
});
