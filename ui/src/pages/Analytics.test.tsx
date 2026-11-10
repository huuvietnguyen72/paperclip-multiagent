// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CostByAgentModel } from "@paperclipai/shared";
import type { AnalyticsRange } from "@/lib/analytics/date-range";
import type { AnalyticsData } from "./analytics/useAnalyticsData";
import { Analytics } from "./Analytics";

vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-1" }) }));
vi.mock("@/context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));

const ranges: AnalyticsRange[] = [];
let data: AnalyticsData;
vi.mock("./analytics/useAnalyticsData", () => ({
  useAnalyticsData: (_companyId: string, range: AnalyticsRange) => {
    ranges.push(range);
    return data;
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const agentNames = ["Backend", "Frontend", "QA", "Tech Lead", "PM", "CEO", "BA"];
const today = new Date();
const at = (h: number, m = 0) => new Date(today.getFullYear(), today.getMonth(), today.getDate(), h, m).toISOString();
const costRow = (agentId: string, agentName: string, model: string, tokens: number) =>
  ({ agentId, agentName, provider: "anthropic", biller: "anthropic", billingType: "subscription_included", model, eventCount: 1, estimatedEventCount: 0, costCents: 0, inputTokens: tokens, cachedInputTokens: 0, outputTokens: 0 }) as CostByAgentModel;

function makeData(): AnalyticsData {
  return {
    agents: agentNames.map((name, i) => ({ id: `a${i}`, name })),
    // Agent a6 (BA) worked least, a0 (Backend) most; times stay within the early hours so they are in the past.
    runs: agentNames.map((_, i) => ({ agentId: `a${i}`, startedAt: at(0, 0), finishedAt: at(0, 50 - i * 5) })),
    costRows: [
      costRow("a0", "Backend", "claude-sonnet-5-5", 300),
      costRow("a2", "QA", "claude-sonnet-5-5", 100),
      costRow("a5", "CEO", "claude-opus-5-5", 150),
      costRow("a1", "Frontend", "gpt-6.1-sol", 50),
    ],
    isLoading: false,
    error: null,
    approximate: false,
  };
}

let container: HTMLDivElement;
let root: Root;

const render = async () => {
  await act(async () => root.render(<Analytics />));
};
const click = async (element: Element | null) => {
  expect(element).not.toBeNull();
  await act(async () => (element as HTMLElement).click());
};
const legend = (id: string) => container.querySelector(`[data-legend='${id}']`);

beforeEach(() => {
  ranges.length = 0;
  data = makeData();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("Analytics page", () => {
  it("stacks the work chart above the token section, whose two lists sit side by side", async () => {
    await render();
    const work = container.querySelector("[data-analytics-section='work']") as HTMLElement;
    const models = container.querySelector("[data-analytics-section='models']") as HTMLElement;
    expect(work.compareDocumentPosition(models) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(work.parentElement?.className ?? "").not.toContain("grid-cols");
    expect(container.querySelector("[data-model-lists]")?.className).toContain("md:grid-cols-2");
  });

  it("starts on today, charted by hour", async () => {
    await render();
    expect(ranges.at(-1)?.unit).toBe("hour");
    expect(container.querySelector("[data-range-preset='today']")?.getAttribute("aria-pressed")).toBe("true");
  });

  it("switches to a 7-day range charted by day", async () => {
    await render();
    await click(container.querySelector("[data-range-preset='7d']"));
    expect(ranges.at(-1)?.unit).toBe("day");
  });

  it("applies a custom from/to range", async () => {
    await render();
    const from = container.querySelector("[data-range-from]") as HTMLInputElement;
    const to = container.querySelector("[data-range-to]") as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(from, "2026-11-01");
      from.dispatchEvent(new Event("input", { bubbles: true }));
      setter.call(to, "2026-11-05");
      to.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const range = ranges.at(-1)!;
    expect(range.unit).toBe("day");
    expect(range.start).toEqual(new Date(2026, 10, 1));
    expect(range.end).toEqual(new Date(2026, 10, 6));
  });

  it("shows the five busiest agents and hides the rest until toggled", async () => {
    await render();
    expect(container.querySelectorAll("[data-series]")).toHaveLength(5);
    expect(legend("a0")?.getAttribute("aria-pressed")).toBe("true");
    expect(legend("a6")?.getAttribute("aria-pressed")).toBe("false");
    await click(legend("a6"));
    expect(container.querySelectorAll("[data-series]")).toHaveLength(6);
    await click(legend("a0"));
    expect(container.querySelector("[data-series='a0']")).toBeNull();
  });

  it("keeps each agent's colour when others are hidden", async () => {
    await render();
    const before = container.querySelector("[data-series='a2']")?.getAttribute("stroke");
    await click(legend("a0"));
    expect(container.querySelector("[data-series='a2']")?.getAttribute("stroke")).toBe(before);
  });

  it("lists total working time per visible agent as a table", async () => {
    await render();
    const table = container.querySelector("[data-worktime-table]");
    expect(table?.textContent).toContain("Backend");
    expect(table?.textContent).toContain("50 phút");
  });

  it("ranks models by tokens and shows the top agents of the selected model", async () => {
    await render();
    const models = Array.from(container.querySelectorAll("[data-model]")).map((node) => node.getAttribute("data-model"));
    expect(models).toEqual(["claude-sonnet-5-5", "claude-opus-5-5", "gpt-6.1-sol"]);
    expect(container.textContent).toContain("Model đã dùng");
    let top = container.querySelector("[data-top-agents]");
    expect(top?.textContent).toContain("Agent dùng Sonnet 5.5");
    expect(top?.textContent).toContain("Backend");
    expect(top?.textContent).toContain("QA");
    await click(container.querySelector("[data-model='claude-opus-5-5']"));
    top = container.querySelector("[data-top-agents]");
    expect(top?.textContent).toContain("CEO");
    expect(top?.textContent).not.toContain("Backend");
  });
});
