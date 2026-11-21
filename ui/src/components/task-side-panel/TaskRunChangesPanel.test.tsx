// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IssueRunChangesEntry, RunChangeFile } from "@paperclipai/shared";
import { TaskRunChangesPanel } from "./TaskRunChangesPanel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mocks = vi.hoisted(() => ({ list: vi.fn(), file: vi.fn() }));
vi.mock("@/api/issues", () => ({ issuesApi: { listRunChanges: mocks.list, getRunChangeFile: mocks.file } }));

let root: Root | undefined;
let container: HTMLDivElement;
afterEach(async () => { if (root) await act(async () => root!.unmount()); container?.remove(); root = undefined; vi.clearAllMocks(); });

async function flush() { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); }
async function render() {
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => { root!.render(<QueryClientProvider client={client}><TaskRunChangesPanel issueId="issue-1" /></QueryClientProvider>); });
  await flush();
}
async function click(element: Element | null | undefined) {
  expect(element).toBeTruthy();
  await act(async () => { (element as HTMLElement).click(); });
  await flush();
}

const file = (path: string, over: Partial<RunChangeFile> = {}): RunChangeFile => ({
  path, oldPath: null, status: "modified", additions: 2, deletions: 1, binary: false, truncated: false, collapsedByDefault: false, ...over,
});
const run = (runId: string, over: Partial<IssueRunChangesEntry> = {}): IssueRunChangesEntry => ({
  runId, agentId: "a1", agentName: "FE", runStatus: "succeeded", startedAt: "2026-11-19T07:32:00.000Z", finishedAt: "2026-11-19T07:40:00.000Z",
  status: "captured", reason: null, additions: 2, deletions: 1, files: [file("src/pages/StudentBookings.tsx")],
  commands: [{ ts: null, tool: "Terminal", text: "npm test" }, { ts: null, tool: "Terminal", text: "git status" }],
  overlappingRunIds: [], branchChanged: false, ...over,
});

describe("TaskRunChangesPanel", () => {
  it("shows an empty state when no run recorded changes", async () => {
    mocks.list.mockResolvedValue([]);
    await render();
    expect(container.textContent).toContain("No code changes recorded for this task yet");
  });

  it("lists runs newest first with agent, totals, files and commands", async () => {
    mocks.list.mockResolvedValue([run("r2", { agentName: "BE" }), run("r1")]);
    await render();
    const headers = [...container.querySelectorAll("[data-run-id]")].map((element) => element.getAttribute("data-run-id"));
    expect(headers).toEqual(["r2", "r1"]);
    expect(container.textContent).toContain("BE");
    expect(container.textContent).toContain("+2");
    expect(container.textContent).toContain("−1");
    expect(container.textContent).toContain("src/pages/StudentBookings.tsx");
    expect(container.textContent).toContain("Commands run (2)");
  });

  it("opens a file and renders deleted and added lines", async () => {
    mocks.list.mockResolvedValue([run("r1")]);
    mocks.file.mockResolvedValue({ runId: "r1", path: "src/pages/StudentBookings.tsx", binary: false, truncated: false,
      patch: "@@ -40,2 +40,2 @@\n const a = 1;\n-return <List />;\n+return <Calendar />;\n" });
    await render();
    await click(container.querySelector('[data-file-path="src/pages/StudentBookings.tsx"]'));
    expect(mocks.file).toHaveBeenCalledWith("issue-1", "r1", "src/pages/StudentBookings.tsx");
    const del = container.querySelector('[data-line-kind="del"]');
    const add = container.querySelector('[data-line-kind="add"]');
    expect(del?.textContent).toContain("return <List />;");
    expect(add?.textContent).toContain("return <Calendar />;");
  });

  it("folds long unchanged context", async () => {
    const context = Array.from({ length: 12 }, (_, index) => ` line ${index}`).join("\n");
    mocks.list.mockResolvedValue([run("r1")]);
    mocks.file.mockResolvedValue({ runId: "r1", path: "src/pages/StudentBookings.tsx", binary: false, truncated: false,
      patch: `@@ -1,13 +1,13 @@\n${context}\n-x\n+y\n` });
    await render();
    await click(container.querySelector('[data-file-path="src/pages/StudentBookings.tsx"]'));
    expect(container.textContent).toContain("6 unchanged lines");
  });

  it("keeps lockfiles collapsed until opened", async () => {
    mocks.list.mockResolvedValue([run("r1", { files: [file("package-lock.json", { collapsedByDefault: true, additions: 900, deletions: 40 })] })]);
    await render();
    const row = container.querySelector('[data-file-path="package-lock.json"]');
    expect(row?.textContent).toContain("collapsed");
    expect(mocks.file).not.toHaveBeenCalled();
  });

  it("groups runs without changes into one line and explains skipped runs", async () => {
    mocks.list.mockResolvedValue([
      run("r3", { status: "no_changes", files: [], additions: 0, deletions: 0 }),
      run("r2", { status: "no_changes", files: [], additions: 0, deletions: 0 }),
      run("r1", { status: "incomplete", reason: "workspace_missing", files: [], additions: 0, deletions: 0 }),
    ]);
    await render();
    expect(container.textContent).toContain("2 runs without code changes");
    expect(container.textContent).toContain("the workspace was removed before the run finished");
  });

  it("groups runs outside a git workspace instead of listing each one", async () => {
    mocks.list.mockResolvedValue([
      run("r3", { status: "skipped", reason: "not_git", files: [], additions: 0, deletions: 0 }),
      run("r2", { status: "skipped", reason: "remote", files: [], additions: 0, deletions: 0 }),
      run("r1", { status: "skipped", reason: "timeout", files: [], additions: 0, deletions: 0 }),
    ]);
    await render();
    expect(container.textContent).toContain("2 runs outside a git workspace");
    expect(container.querySelectorAll("[data-run-id]")).toHaveLength(1);
    expect(container.textContent).toContain("snapshot timed out");
  });

  it("warns when another run overlapped or the branch changed", async () => {
    mocks.list.mockResolvedValue([run("r1", { overlappingRunIds: ["r0"], branchChanged: true })]);
    await render();
    expect(container.textContent).toContain("may include changes from another run");
    expect(container.textContent).toContain("switched branches");
  });
});
