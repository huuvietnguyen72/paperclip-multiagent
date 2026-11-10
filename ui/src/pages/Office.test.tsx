// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OfficeAgentView } from "@/lib/office/agent-state";
import type { OfficeData } from "./office/useOfficeData";
import { Office } from "./Office";

const openNewIssue = vi.fn();
let data: OfficeData;

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, className }: { to: string; children: React.ReactNode; className?: string }) => (
    <a href={to} className={className}>{children}</a>
  ),
}));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-1" }) }));
vi.mock("@/context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));
vi.mock("@/context/DialogContext", () => ({ useDialog: () => ({ openNewIssue }) }));
vi.mock("./office/useOfficeData", () => ({ useOfficeData: () => data }));
const recentTasksCalls: Array<string | null> = [];
vi.mock("./office/useRecentTasks", () => ({
  useRecentTasks: (_companyId: string, agentId: string | null) => {
    recentTasksCalls.push(agentId);
    return {
      tasks: agentId
        ? [{ id: "i24", identifier: "QUA-24", title: "Build booking API", status: "in_progress", assigneeAgentId: agentId, updatedAt: "2026-11-10T09:58:00Z" }]
        : [
            { id: "i25", identifier: "QUA-25", title: "Fix TC-AUTH-09", status: "in_review", assigneeAgentId: "qa", updatedAt: "2026-11-10T09:59:00Z" },
            { id: "i24", identifier: "QUA-24", title: "Build booking API", status: "in_progress", assigneeAgentId: "be", updatedAt: "2026-11-10T09:58:00Z" },
          ],
      isLoading: false,
    };
  },
}));
vi.mock("@/components/office/OfficeStage", () => ({
  default: (props: { selectedId: string | null; onSelect(id: string | null): void }) => (
    <div data-testid="stage" data-selected={props.selectedId ?? ""}>
      <button type="button" data-testid="stage-clear" onClick={() => props.onSelect(null)} />
    </div>
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = Date.parse("2026-11-10T10:00:00Z");

function view(overrides: Partial<OfficeAgentView> & { id: string }): OfficeAgentView {
  return {
    name: overrides.id,
    urlKey: overrides.id,
    role: "engineer",
    department: "engineering",
    paletteId: "coral-mint",
    muted: false,
    group: "idle",
    hasLiveRun: false,
    spot: "pantry",
    pose: "idle",
    marker: null,
    currentIssue: null,
    attentionIssue: null,
    statusLine: null,
    runStartedAt: null,
    waitingOn: null,
    lastHeartbeatAt: null,
    badge: { label: "Sonnet 5.5", markType: "claude_local" },
    assignedFlashUntil: null,
    ...overrides,
  };
}

function makeData(agents: OfficeAgentView[]): OfficeData {
  return {
    agents,
    stats: {
      company: { doneCount: 18, tokens: 100_400_000, spendCents: 5.77, runtimeMs: 51_600_000, workingCount: 1, shownCount: agents.length, runtimeApproximate: false },
      byAgent: new Map(),
    },
    feed: [],
    isLoading: false,
    error: null,
    now: NOW,
  };
}

let container: HTMLDivElement;
let root: Root;

async function render() {
  await act(async () => {
    root.render(<Office />);
  });
  // Let the lazily loaded stage resolve.
  await act(async () => {
    await Promise.resolve();
  });
}

const click = async (element: Element | null) => {
  expect(element).not.toBeNull();
  await act(async () => {
    (element as HTMLElement).click();
  });
};

beforeEach(() => {
  openNewIssue.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  data = makeData([
    view({ id: "ceo", name: "CEO", role: "ceo", department: "executive", badge: { label: "Opus 5.5", markType: "claude_local" } }),
    view({ id: "qa", name: "QA Engineer", role: "qa", department: "quality", group: "attention", marker: "attention" }),
    view({ id: "be", name: "Backend", group: "working", hasLiveRun: true, spot: "desk", pose: "typing", runStartedAt: new Date(NOW - 760_000).toISOString(), currentIssue: { id: "i24", identifier: "QUA-24" } }),
  ]);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("Office page", () => {
  it("renders the three rail groups in order with counts", async () => {
    await render();
    const groups = Array.from(container.querySelectorAll("[data-office-group]")).map((node) => node.getAttribute("data-office-group"));
    expect(groups).toEqual(["attention", "working", "idle"]);
    expect(container.textContent).toContain("Cần bạn xử lý");
    expect(container.querySelector("[data-office-count='working']")?.textContent).toContain("1");
  });

  it("shows the elapsed timer on a working card", async () => {
    await render();
    expect(container.querySelector("[data-agent-card='be']")?.textContent).toContain("12:40");
  });

  it("shows the timer on an attention card that is running and links the issue that needs the owner", async () => {
    data = makeData([
      view({
        id: "pm", name: "PM", role: "pm", department: "executive", group: "attention", marker: "attention", hasLiveRun: true,
        runStartedAt: new Date(NOW - 65_000).toISOString(), statusLine: "Reviewing",
        currentIssue: { id: "i2", identifier: "QUA-2" }, attentionIssue: { id: "i1", identifier: "QUA-1" },
      }),
    ]);
    await render();
    const card = container.querySelector("[data-agent-card='pm']");
    expect(card?.textContent).toContain("1:05");
    expect(card?.textContent).toContain("Reviewing");
    expect(container.querySelector("[data-office-count='working']")?.textContent).toContain("1");
    await click(container.querySelector("[data-agent-card='pm'] [data-select]"));
    expect(container.querySelector("[data-agent-card='pm'] a[href='/issues/QUA-1']")).not.toBeNull();
  });

  it("shows the company's recent tasks when no agent is selected", async () => {
    await render();
    const section = container.querySelector("[data-recent-tasks]");
    expect(section?.textContent).toContain("Task gần đây");
    expect(section?.textContent).toContain("QUA-25");
    expect(section?.textContent).toContain("Fix TC-AUTH-09");
    expect(section?.textContent).toContain("QA Engineer");
    expect(section?.querySelector("a[href='/issues/QUA-25']")).not.toBeNull();
    expect(recentTasksCalls.at(-1)).toBeNull();
  });

  it("shows only the selected agent's recent tasks, and all again after deselecting", async () => {
    await render();
    await click(container.querySelector("[data-agent-card='be'] [data-select]"));
    let section = container.querySelector("[data-recent-tasks]");
    expect(recentTasksCalls.at(-1)).toBe("be");
    expect(section?.textContent).toContain("Task gần đây của Backend");
    expect(section?.textContent).not.toContain("QUA-25");
    await click(container.querySelector("[data-agent-card='be'] [data-select]"));
    section = container.querySelector("[data-recent-tasks]");
    expect(recentTasksCalls.at(-1)).toBeNull();
    expect(section?.textContent).toContain("QUA-25");
  });

  it("marks an approximate runtime", async () => {
    data.stats.company.runtimeApproximate = true;
    await render();
    expect(container.querySelector("[data-stat='runtime']")?.textContent).toContain("≈ 14h 20m");
  });

  it("shows tokens and spend in the cost tile", async () => {
    await render();
    const tile = container.querySelector("[data-stat='cost']");
    expect(tile?.textContent).toContain("100M token");
    expect(tile?.textContent).toContain("$0.06");
  });

  it("renders the model badge label", async () => {
    await render();
    expect(container.querySelector("[data-agent-card='ceo']")?.textContent).toContain("Opus 5.5");
  });

  it("assigns work to the selected agent", async () => {
    await render();
    await click(container.querySelector("[data-agent-card='be'] [data-select]"));
    await click(container.querySelector("[data-agent-card='be'] [data-assign]"));
    expect(openNewIssue).toHaveBeenCalledWith({ assigneeAgentId: "be" });
  });

  it("assigns work to the CEO when no agent is selected", async () => {
    await render();
    await click(container.querySelector("[data-assign-default]"));
    expect(openNewIssue).toHaveBeenCalledWith({ assigneeAgentId: "ceo" });
  });

  it("opens an unassigned dialog when there is no CEO", async () => {
    data = makeData([view({ id: "be", name: "Backend" })]);
    await render();
    await click(container.querySelector("[data-assign-default]"));
    expect(openNewIssue).toHaveBeenCalledWith(undefined);
  });

  it("passes the selection to the stage and clears it from the stage", async () => {
    await render();
    await click(container.querySelector("[data-agent-card='qa'] [data-select]"));
    expect(container.querySelector("[data-testid='stage']")?.getAttribute("data-selected")).toBe("qa");
    expect(container.querySelector("[data-agent-card='qa']")?.getAttribute("data-selected")).toBe("true");
    await click(container.querySelector("[data-testid='stage-clear']"));
    expect(container.querySelector("[data-agent-card='qa']")?.getAttribute("data-selected")).toBe("false");
  });
});
