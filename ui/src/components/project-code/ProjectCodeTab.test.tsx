// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectCodeViewStatus } from "@paperclipai/shared";
import { ProjectCodeTab } from "./ProjectCodeTab";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mocks = vi.hoisted(() => ({ list: vi.fn(), refresh: vi.fn(), listFiles: vi.fn() }));
vi.mock("@/api/project-code-view", () => ({
  projectCodeViewApi: {
    list: mocks.list,
    refresh: mocks.refresh,
    listFiles: mocks.listFiles,
    resolve: vi.fn(),
    content: vi.fn(),
    downloadUrl: () => "/download",
  },
}));

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
        <MemoryRouter initialEntries={["/projects/p1/code"]}>
          <ProjectCodeTab projectId="p1" />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await flush();
  await flush();
}

const status = (over: Partial<ProjectCodeViewStatus> = {}): ProjectCodeViewStatus => ({
  projectId: "p1", workspaceId: "w1", workspaceName: "Codebase (local main)", branch: "main", head: "87d6557",
  subject: "fix(web): a11y", lastUpdatedAt: new Date().toISOString(), lastResult: "up_to_date", lastError: null,
  refreshing: false, ...over,
});
const emptyList = {
  kind: "workspace_file_list", state: "available", workspace: null,
  query: { workspace: "project", mode: "all", q: null, limit: 100, offset: 0, path: null },
  items: [], scannedCount: 0, truncated: false,
};

describe("ProjectCodeTab", () => {
  it("shows which code is displayed and refreshes once when opened", async () => {
    mocks.list.mockResolvedValue({ workspaces: [status()] });
    mocks.refresh.mockResolvedValue(status());
    mocks.listFiles.mockResolvedValue(emptyList);
    await render();
    expect(container.textContent).toContain("main · 87d6557 \"fix(web): a11y\" · updated");
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    expect(mocks.refresh).toHaveBeenCalledWith("p1", "w1", "open");
  });

  it("refreshes on demand with the Update button", async () => {
    mocks.list.mockResolvedValue({ workspaces: [status()] });
    mocks.refresh.mockResolvedValue(status());
    mocks.listFiles.mockResolvedValue(emptyList);
    await render();
    const button = [...container.querySelectorAll("button")].find((element) => element.textContent?.trim() === "Update");
    expect(button).toBeTruthy();
    await act(async () => { button!.click(); });
    await flush();
    expect(mocks.refresh).toHaveBeenLastCalledWith("p1", "w1", "manual");
  });

  it("explains why the local copy was not updated", async () => {
    mocks.list.mockResolvedValue({ workspaces: [status({ lastResult: "skipped_dirty" })] });
    mocks.refresh.mockResolvedValue(status({ lastResult: "skipped_dirty" }));
    mocks.listFiles.mockResolvedValue(emptyList);
    await render();
    expect(container.textContent).toContain("Not updated: the local copy has uncommitted changes.");
  });

  it("tells the user when the update request fails", async () => {
    mocks.list.mockResolvedValue({ workspaces: [status()] });
    mocks.refresh.mockRejectedValue(new Error("network down"));
    mocks.listFiles.mockResolvedValue(emptyList);
    await render();
    expect(container.textContent).toContain("Update failed:");
    expect(container.textContent).toContain("network down");
  });

  it("shows how to set it up when the project has no code copy", async () => {
    mocks.list.mockResolvedValue({ workspaces: [] });
    await render();
    expect(container.textContent).toContain("No local code copy is set up for this project. Add a local workspace and enable the code view on it.");
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
});
