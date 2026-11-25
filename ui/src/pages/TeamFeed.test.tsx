// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TeamFeedItem } from "@paperclipai/shared";
import { TeamFeed } from "./TeamFeed";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mocks = vi.hoisted(() => ({ list: vi.fn(), setBreadcrumbs: vi.fn() }));
vi.mock("@/api/team-feed", () => ({ teamFeedApi: { list: mocks.list } }));
vi.mock("../context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-1" }) }));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-1" }) }));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: mocks.setBreadcrumbs }) }));

let root: Root | undefined;
let container: HTMLDivElement;
afterEach(async () => { if (root) await act(async () => root!.unmount()); container?.remove(); root = undefined; vi.clearAllMocks(); });

async function flush() { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); }
async function render() {
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root!.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/team-feed"]}><TeamFeed /></MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await flush();
  await flush();
}

const item = (over: Partial<TeamFeedItem> = {}): TeamFeedItem => ({
  id: "a1", at: new Date().toISOString(),
  actor: { kind: "agent", agentId: "fe", name: "FE" },
  reason: null,
  issue: { id: "i1", identifier: "QUA-57", title: "Màn hình Admin đối soát" },
  fromStatus: "in_progress", toStatus: "done",
  note: "Đã thêm trang /admin/earnings",
  changes: {
    totalFiles: 7, additions: 160, deletions: 9, pending: false,
    files: [
      { path: "apps/web/src/A.tsx", additions: 120, deletions: 8, binary: false },
      { path: "apps/web/src/b.ts", additions: 20, deletions: 1, binary: false },
      { path: "apps/web/src/c.ts", additions: 10, deletions: 0, binary: false },
      { path: "apps/web/src/d.ts", additions: 5, deletions: 0, binary: false },
      { path: "apps/web/src/e.ts", additions: 3, deletions: 0, binary: false },
    ],
  },
  ...over,
});

describe("TeamFeed", () => {
  it("shows who moved which task, their note and the files changed", async () => {
    mocks.list.mockResolvedValue({ items: [item()], nextCursor: null });
    await render();
    const text = container.textContent ?? "";
    expect(text).toContain("FE");
    expect(text).toContain("QUA-57");
    expect(text).toContain("Màn hình Admin đối soát");
    expect(text).toContain("Đã thêm trang /admin/earnings");
    expect(text).toContain("apps/web/src/A.tsx");
    expect(text).toContain("+120");
    expect(text).toContain("−8");
    expect(text).toContain("… 2 more files");
    expect(container.querySelector('[data-from-status="in_progress"]')).toBeTruthy();
    expect(container.querySelector('[data-to-status="done"]')).toBeTruthy();
    expect(mocks.list).toHaveBeenCalledWith("company-1", { before: null });
  });

  it("names system changes and their reason", async () => {
    mocks.list.mockResolvedValue({
      items: [item({ actor: { kind: "system", agentId: null, name: "System" }, reason: "recovery.reconcile_configuration_incomplete", toStatus: "blocked", changes: null, note: null })],
      nextCursor: null,
    });
    await render();
    expect(container.textContent).toContain("System");
    expect(container.textContent).toContain("recovery.reconcile_configuration_incomplete");
  });

  it("says when changes are still being recorded", async () => {
    mocks.list.mockResolvedValue({ items: [item({ changes: { totalFiles: 0, additions: 0, deletions: 0, pending: true, files: [] } })], nextCursor: null });
    await render();
    expect(container.textContent).toContain("Changes are still being recorded…");
  });

  it("shows an empty state", async () => {
    mocks.list.mockResolvedValue({ items: [], nextCursor: null });
    await render();
    expect(container.textContent).toContain("No task updates yet.");
  });

  it("loads older updates with the cursor", async () => {
    mocks.list.mockResolvedValueOnce({ items: [item()], nextCursor: "c1" }).mockResolvedValueOnce({ items: [item({ id: "a0" })], nextCursor: null });
    await render();
    const button = [...container.querySelectorAll("button")].find((element) => element.textContent?.trim() === "Load older");
    expect(button).toBeTruthy();
    await act(async () => { button!.click(); });
    await flush();
    expect(mocks.list).toHaveBeenLastCalledWith("company-1", { before: "c1" });
  });
});
