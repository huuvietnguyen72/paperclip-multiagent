# Project Code Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only "Code" tab on the project page. It browses a flagged local project workspace, and the
server keeps that clone fast-forwarded: when a task in the project becomes done, when the tab opens, and when the
user presses Update.

**Architecture:**
- A new server module `services/project-code-view/` has three parts:
  - a git helper that reads HEAD and does fast-forward refreshes;
  - a service that owns the opt-in flag, the throttle, the per-workspace lock, metadata persistence and activity
    logging;
  - a worker that listens for `activity.logged` issue→done events.
- Project-scoped file routes reuse `workspaceFileResourceService` through new project-target methods.
- The UI adds a `ProjectCodeTab`. It reuses `WorkspaceFileBrowser` through a new `scope` prop, and `FileViewerBody`
  for content.

**Tech Stack:** TypeScript, Express, Drizzle (embedded Postgres in tests), React + TanStack Query, Vitest, supertest,
Testing Library.

**Spec:** `doc/plans/2026-11-24-project-code-tab-design.md`

## Global Constraints

**Feature behaviour**
- Opt-in: a workspace participates only when `metadata.codeView.enabled === true` and `cwd` is non-empty. Anything
  else gets 404 from the code-view routes and is never pulled.
- Pull policy:
  1. `git fetch --quiet origin`;
  2. then, only on a clean tree on a branch with an upstream, `git merge --ff-only @{upstream}`;
  3. never reset, stash, checkout or clean.
- Git runs with `execFile`, fixed argument arrays, no shell, a timeout of 60 000 ms
  (`PROJECT_CODE_VIEW_GIT_TIMEOUT_MS`), and `GIT_TERMINAL_PROMPT=0`.
- An open-reason refresh within 60 000 ms (`PROJECT_CODE_VIEW_OPEN_THROTTLE_MS`) of `lastUpdatedAt` is a no-op.
- At most one refresh runs per workspace at a time; concurrent callers share the same promise.
- Activity: action `project.code_view_refreshed`, entityType `project`. It is logged for `manual` always, and for
  `open`/`task_done` only when HEAD changed.
- `lastError` is redacted with `redactSensitiveText` and truncated to 500 chars.
- Agents never pull and never become involved. The workspace's `isPrimary` and execution selection are untouched.

**Access and auditing**
- Routes are board only (`assertBoard`) and check company access. A cross-company request gets the same 404 as a
  missing project.
- Content reads are audited like the issue routes, with action `project.code_file_content_read` (entityType
  `project`, entityId the project id).

**UI**
- Strings are English.
- Styling is token-only: `pnpm check:token-gates` must pass.

**Process**
- Tests: run one vitest file at a time with `--maxWorkers=2`. Never run the full suite while the live server runs.
- Commits: end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never push.

## Review Focus

1. **The clone has local edits** (someone edited `~/tutorbooking`). Expected: no pull, `lastResult: "skipped_dirty"`,
   a warning line in the tab, and the files unchanged. Covered in Task 2.
2. **Network or GitHub is unreachable** during fetch. Expected: `lastResult: "error"` with a short redacted message;
   the tab still lists the existing files and the issue update never fails. Covered in Tasks 2 and 3.
3. **Rapid tab reopenings or a burst of done events** (the PM closes 5 tasks at once). Expected: one git process at
   a time, and open refreshes throttled. Covered in Task 3.
4. **Path traversal or denied paths** through the project routes (`../`, `.git/config`, `.env`). Expected: the same
   denial as the issue routes, because the same service validation is reused. Covered in Task 5.
5. **A workspace from another project or company, or a non-flagged one,** passed to the project routes. Expected:
   404, and nothing is read or pulled. Covered in Task 5.

---

### Task 1: Shared code-view contract

**Files:**
- Create: `packages/shared/src/project-code-view.ts`
- Modify: `packages/shared/src/index.ts` (export it)
- Test: `packages/shared/src/project-code-view.test.ts`

**Interfaces — Produces:**
```ts
export type ProjectCodeViewResult = "updated" | "up_to_date" | "skipped_dirty" | "skipped_detached" | "diverged" | "error";
export type ProjectCodeRefreshReason = "open" | "manual" | "task_done";
export interface ProjectCodeViewMetadata { enabled: boolean; lastUpdatedAt: string | null; lastResult: ProjectCodeViewResult | null; lastError: string | null; head: string | null }
export interface ProjectCodeViewStatus {
  projectId: string; workspaceId: string; workspaceName: string;
  branch: string | null; head: string | null /* short sha */; subject: string | null;
  lastUpdatedAt: string | null; lastResult: ProjectCodeViewResult | null; lastError: string | null; refreshing: boolean;
}
export const PROJECT_CODE_VIEW_OPEN_THROTTLE_MS = 60_000;
export const PROJECT_CODE_VIEW_GIT_TIMEOUT_MS = 60_000;
export function readProjectCodeViewMetadata(metadata: unknown): ProjectCodeViewMetadata | null; // null unless metadata.codeView.enabled === true
```

- [ ] **Step 1: Write the failing tests.** In `readProjectCodeViewMetadata`:
  - it returns `null` for `null`, for `{}`, for `{ codeView: { enabled: "true" } }` and for
    `{ codeView: { enabled: false } }`;
  - for `{ codeView: { enabled: true } }` it returns `{ enabled: true, lastUpdatedAt: null, lastResult: null,
    lastError: null, head: null }`;
  - it drops an unknown `lastResult` value (`"weird"` → `null`).
- [ ] **Step 2:** Run `pnpm --filter @paperclipai/shared exec vitest run src/project-code-view.test.ts --maxWorkers=2`.
  Expect FAIL (module missing).
- [ ] **Step 3:** Implement the module and add the export.
- [ ] **Step 4:** Re-run. Expect PASS.
- [ ] **Step 5:** Commit `feat(shared): project code view contract`.

### Task 2: Git helper (read head, fast-forward refresh)

**Files:**
- Create: `server/src/services/project-code-view/git.ts`
- Test: `server/src/services/project-code-view/git.test.ts`

**Interfaces:**
- Consumes: `ProjectCodeViewResult` and `PROJECT_CODE_VIEW_GIT_TIMEOUT_MS` from Task 1.
- Produces:
```ts
export interface CloneHead { branch: string | null; head: string | null; subject: string | null }
export async function readCloneHead(cwd: string): Promise<CloneHead>; // nulls when cwd is not a git repo
export async function refreshClone(cwd: string, opts?: { timeoutMs?: number }): Promise<{ result: ProjectCodeViewResult; before: string | null; after: string | null; error: string | null }>;
```

**Algorithm for `refreshClone`:**
1. `rev-parse HEAD` → `before`.
2. `fetch --quiet origin`. On failure → `error`.
3. `symbolic-ref --quiet --short HEAD`. If it fails → `skipped_detached`.
4. `rev-parse --abbrev-ref --symbolic-full-name @{upstream}`. If it fails → `skipped_detached`.
5. `status --porcelain`. If non-empty → `skipped_dirty`.
6. `merge-base --is-ancestor HEAD @{upstream}`. If false → `diverged`.
7. `merge --ff-only @{upstream}`.
8. `after` = HEAD. The result is `updated` when `after !== before`, else `up_to_date`.

Any thrown git error maps to `error`, with the stderr's first line truncated to 500 chars.

- [ ] **Step 1: Write the failing tests.** Fixture: a temp bare repo `origin.git`, a seeding clone that commits
  `README.md`, and a clone `view/` that tracks `main`. Tests:
  - `readCloneHead(view)` → `{ branch: "main", head: <7+ char sha>, subject: "init" }`;
  - after a new commit is pushed from the seeding clone, `refreshClone(view)` → `result: "updated"`, `after !==
    before`, and the new file exists in `view/`;
  - a second call → `"up_to_date"`;
  - an untracked file in `view/` plus a pushed commit → `"skipped_dirty"`, and HEAD is unchanged;
  - `git checkout --detach` → `"skipped_detached"`;
  - a local commit in `view/` plus a different pushed commit → `"diverged"`, and the local commit is still HEAD;
  - origin URL set to a missing path → `"error"` with a non-empty `error` string;
  - `readCloneHead` on a plain temp dir → all nulls.
- [ ] **Step 2:** Run `cd server && npx vitest run src/services/project-code-view/git.test.ts --maxWorkers=2`.
  Expect FAIL.
- [ ] **Step 3:** Implement with `execFile("git", ["-C", cwd, ...args], { timeout, env: { ...process.env,
  GIT_TERMINAL_PROMPT: "0" } })`.
- [ ] **Step 4:** Re-run. Expect PASS.
- [ ] **Step 5:** Commit `feat(server): fast-forward refresh helper for project code view`.

### Task 3: Code-view service and done-task worker

**Files:**
- Create: `server/src/services/project-code-view/service.ts`, `worker.ts` and `index.ts` (re-exports)
- Modify: `server/src/index.ts` (create the service and register the worker next to `registerRunChangesWork`)
- Test: `server/src/services/project-code-view/service.test.ts` and `worker.test.ts`

**Interfaces:**
- Consumes: Task 1 types; `readCloneHead` and `refreshClone` from Task 2; `logActivity` and `redactSensitiveText`
  (both already used by `run-changes/service.ts`).
- Produces:
```ts
export function createProjectCodeViewService(db: Db, deps?: { git?: { readCloneHead: typeof readCloneHead; refreshClone: typeof refreshClone }; now?: () => Date });
// methods:
listStatuses(companyId: string, projectId: string): Promise<ProjectCodeViewStatus[]>;          // flagged workspaces of the project only
getEnabledWorkspace(companyId: string, projectId: string, workspaceId: string): Promise<typeof projectWorkspaces.$inferSelect | null>;
refresh(input: { companyId: string; projectId: string; workspaceId: string; reason: ProjectCodeRefreshReason; actor?: { actorType: "user" | "agent" | "system"; actorId: string } }): Promise<ProjectCodeViewStatus>; // throws notFound when not enabled
refreshProject(companyId: string, projectId: string, reason: ProjectCodeRefreshReason): Promise<void>;
export type ProjectCodeViewService = ReturnType<typeof createProjectCodeViewService>;
export function registerProjectCodeViewRefresh(service: Pick<ProjectCodeViewService, "refreshProject">, db: Db): { stop(): void };
```

**Behaviour of `refresh`:**
- It merges the outcome into `metadata.codeView` as `{ enabled: true, lastUpdatedAt, lastResult, lastError, head }`,
  keeping every other metadata key.
- `refreshing` is true while the lock is held.

**The worker:**
- It uses `subscribeAllCompanyLiveEvents`.
- On `event.type === "activity.logged"` with `payload.entityType === "issue"`, `payload.action ===
  "issue.updated"` and `payload.details?.status === "done"`, it loads the issue's `projectId` (company-scoped). If
  there is one, it calls `refreshProject(companyId, projectId, "task_done")`.
- Errors are caught and logged with the server logger. They are never thrown.

- [ ] **Step 1: Write the failing service tests.** Use embedded Postgres and a fake `git`. Tests:
  - `listStatuses` returns only the flagged workspace (seed one flagged, one unflagged, and one flagged in another
    project);
  - `refresh` writes `metadata.codeView.lastResult` and `lastUpdatedAt`, and keeps an unrelated metadata key;
  - an `open` refresh within 60 s of `lastUpdatedAt` does not call `git.refreshClone` (with `now` injected);
  - two concurrent `refresh` calls invoke `git.refreshClone` once;
  - `manual` logs one `project.code_view_refreshed` activity row; `open` with `before === after` logs none;
  - `open` with a moved HEAD logs one;
  - `refresh` on an unflagged workspace rejects with status 404;
  - a fake git that throws yields `lastResult: "error"` and a redacted `lastError`.
- [ ] **Step 2: Write the failing worker test.** Publish an `activity.logged` live event for an issue with a
  `projectId`, status `done` → `refreshProject` is called with `(companyId, projectId, "task_done")`. Status
  `in_progress`, or `entityType: "agent"` → not called. A `refreshProject` that rejects does not throw.
- [ ] **Step 3:** Run both files (`npx vitest run src/services/project-code-view/service.test.ts --maxWorkers=2`,
  then `worker.test.ts`). Expect FAIL.
- [ ] **Step 4:** Implement both and wire `server/src/index.ts`.
- [ ] **Step 5:** Re-run both. Expect PASS. Run `pnpm --filter @paperclipai/server typecheck` and expect exit 0.
- [ ] **Step 6:** Commit `feat(server): project code view service and done-task refresh`.

### Task 4: Project-target methods in workspace file resources

**Files:**
- Modify: `server/src/services/workspace-file-resources.ts`

**Interfaces — Produces** (added to the object returned by `workspaceFileResourceService`):
```ts
export interface ProjectWorkspaceFileTarget { companyId: string; projectId: string; workspaceId: string }
listForProjectWorkspace(target: ProjectWorkspaceFileTarget, input: Omit<WorkspaceFileListQueryInput, "workspace" | "projectId" | "workspaceId">, opts?: { scanContext?: WorkspaceFileScanContext }): Promise<WorkspaceFileListResponse>;
resolveForProjectWorkspace(target: ProjectWorkspaceFileTarget, input: { path: string }): Promise<ResolvedWorkspaceResource>;
readContentForProjectWorkspace(target: ProjectWorkspaceFileTarget, input: { path: string }): Promise<WorkspaceFileContent>;
prepareDownloadForProjectWorkspace(target: ProjectWorkspaceFileTarget, input: { path: string }): ReturnType<WorkspaceFileResourceService["prepareDownload"]>;
```

**Approach:**
- Generalize `targetProjectWorkspaceCandidate` to take `companyId` instead of the issue.
- Have `list`, `resolve`, `readContent` and `prepareDownload` call a shared core that receives the candidate list
  and an `explicitTarget` flag. The new methods pass the single project-target candidate with `explicitTarget =
  true`.
- Issue behaviour must not change. This task has no new test file: Task 5's route tests exercise these methods, and
  the existing `file-resources.test.ts` guards the issue path.

- [ ] **Step 1:** Implement the refactor.
- [ ] **Step 2:** Run `npx vitest run src/__tests__/file-resources.test.ts --maxWorkers=2`. Expect PASS
  (unchanged).
- [ ] **Step 3:** Commit together with Task 5. The route tests prove the new methods.

### Task 5: Project code-view routes

**Files:**
- Create: `server/src/routes/project-code-view.ts`
- Modify: `server/src/app.ts` (mount next to `fileResourceRoutes`)
- Test: `server/src/__tests__/project-code-view-routes.test.ts`

**Interfaces:**
- Consumes: Task 3's service and Task 4's methods.
- Produces (all under `/api`):
  - `GET /projects/:projectId/code-view` → `{ workspaces: ProjectCodeViewStatus[] }`
  - `POST /projects/:projectId/workspaces/:workspaceId/code-view/refresh`, body `{ reason: "open" | "manual" }` →
    `ProjectCodeViewStatus`. A reason of `task_done` from the client gets 400.
  - `GET /projects/:projectId/workspaces/:workspaceId/file-resources/list` takes `path`, `q`, `mode` (`all`
    default), `limit` and `offset`, and returns `WorkspaceFileListResponse`.
  - `GET .../file-resources/resolve?path=` → `ResolvedWorkspaceResource`.
  - `GET .../file-resources/content?path=[&download=1]` → `WorkspaceFileContent`, or the raw file when downloading.

**Route behaviour:**
- Signature: `projectCodeViewRoutes(db, opts: { service?: ProjectCodeViewService; remoteFiles?: ... })`.
- Every workspace route calls `getEnabledWorkspace` first, so it returns 404 when the workspace is not flagged.
- Reuse the exported limiter factories `createFileResourceLimiter` and `createFileResourceListLimiter`, keyed by
  `companyId:actorId:workspaceId`.

- [ ] **Step 1: Write the failing route tests.** Use embedded Postgres. Seed a company, a project and a flagged
  workspace whose `cwd` is a temp git repo (`apps/web/main.ts`, `README.md`, `.env`); an unflagged workspace; and a
  flagged workspace in another company. Use a fake service git for the refresh. Tests:
  - code-view list → only the flagged workspace;
  - file list without `path` → root children include `apps` and `README.md`, and `query.mode === "all"`;
  - file list with `path=apps` → `web`;
  - content `README.md` → 200, with one `project.code_file_content_read` activity row;
  - content `../outside` → 4xx;
  - content `.env` → the same denial status as the issue route gives for `.env`;
  - the unflagged workspace → 404 on list and content;
  - the other company's project → 404;
  - an agent actor → 403;
  - refresh `manual` → 200 with `lastResult`;
  - refresh `task_done` → 400.
- [ ] **Step 2:** Run `npx vitest run src/__tests__/project-code-view-routes.test.ts --maxWorkers=2`. Expect FAIL.
- [ ] **Step 3:** Implement the routes and mount them.
- [ ] **Step 4:** Re-run. Expect PASS. Run the server typecheck and expect exit 0.
- [ ] **Step 5:** Commit `feat(server): project-scoped code view and file routes` (this includes Task 4).

### Task 6: UI API client and file-browser scope

**Files:**
- Create: `ui/src/api/project-code-view.ts`
- Modify:
  - `ui/src/lib/queryKeys.ts`: add `projects.codeView(projectId)` and `projects.codeFiles(projectId, workspaceId,
    query)`;
  - `ui/src/components/WorkspaceFileBrowser.tsx`.
- Test: `ui/src/components/WorkspaceFileBrowser.test.tsx` (add cases)

**Interfaces — Produces:**
```ts
export const projectCodeViewApi = {
  list(projectId: string): Promise<{ workspaces: ProjectCodeViewStatus[] }>,
  refresh(projectId: string, workspaceId: string, reason: "open" | "manual"): Promise<ProjectCodeViewStatus>,
  listFiles(projectId: string, workspaceId: string, query: { path?: string | null; q?: string | null; mode?: "all"; limit?: number; offset?: number }, options?: RequestOptions): Promise<WorkspaceFileListResponse>,
  resolve(projectId: string, workspaceId: string, path: string): Promise<ResolvedWorkspaceResource>,
  content(projectId: string, workspaceId: string, path: string): Promise<WorkspaceFileContent>,
  downloadUrl(projectId: string, workspaceId: string, path: string): string,
};
export type WorkspaceFileBrowserScope = { kind: "issue"; issueId: string } | { kind: "project"; projectId: string; workspaceId: string };
```

**`WorkspaceFileBrowser` change:**
- Make `issueId` optional and add an optional `scope?: WorkspaceFileBrowserScope`. The default is `{ kind: "issue",
  issueId }`, so existing call sites stay as they are.
- With project scope:
  - the list calls `projectCodeViewApi.listFiles`;
  - `mode` is always `"all"`, including at the root (no "changed" mode);
  - the current/other workspace source switcher is hidden;
  - the download link uses `projectCodeViewApi.downloadUrl`;
  - the query keys use `projects.codeFiles`.

- [ ] **Step 1: Write the failing tests** (new cases):
  - with `scope={{ kind: "project", projectId: "p1", workspaceId: "w1" }}` and no folder,
    `projectCodeViewApi.listFiles` is called with `("p1", "w1", expect.objectContaining({ mode: "all" }))`, and the
    issue `fileResourcesApi.list` is not called;
  - the source switcher is absent;
  - clicking a folder item calls `listFiles` with `path: "apps"`.
- [ ] **Step 2:** Run `cd ui && npx vitest run src/components/WorkspaceFileBrowser.test.tsx --maxWorkers=2`. Expect
  the new cases to FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Re-run the whole file. Expect all PASS, including the existing issue cases.
- [ ] **Step 5:** Commit `feat(ui): project scope for the workspace file browser`.

### Task 7: Code tab on the project page

**Files:**
- Create:
  - `ui/src/components/project-code/ProjectCodeTab.tsx`: header, workspace selector, browser and viewer layout;
  - `ui/src/components/project-code/ProjectCodeFilePanel.tsx`: resolve/content queries plus `FileViewerBody`,
    modelled on `task-side-panel/TaskWorkspaceFilePanel.tsx`.
- Modify:
  - `ui/src/pages/ProjectDetail.tsx`: add `"code"` to `ProjectBaseTab`, map segment `code` in `resolveProjectTab`, add
    `navigate(.../code)` in `handleTabChange`, add the tab item `{ value: "code", label: "Code" }` right after Tasks,
    and render `<ProjectCodeTab projectId=… />`;
  - `ui/src/App.tsx`: add the route `projects/:projectId/code` → `ProjectDetail`.
- Test: `ui/src/components/project-code/ProjectCodeTab.test.tsx`; extend `ui/src/pages/ProjectDetail.test.tsx`.

**Interfaces:**
- Consumes: Task 6's `projectCodeViewApi` and the browser `scope` prop.
- Produces: `export function ProjectCodeTab({ projectId }: { projectId: string }): JSX.Element`.

**Header copy (exact):**
- Head line: `{branch} · {head} "{subject}" · updated {relative time}`.
- Button: `Update`, labelled `Updating…` while the refresh is pending.
- Warning lines:
  - `skipped_dirty` → "Not updated: the local copy has uncommitted changes."
  - `skipped_detached` → "Not updated: the local copy is not on a tracking branch."
  - `diverged` → "Not updated: the local copy has commits that are not on the remote."
  - `error` → "Last update failed: {lastError}".
- Empty state: "No local code copy is set up for this project. Add a local workspace and enable the code view on it."
  It links to the project's Workspaces tab.

**Behaviour:**
- On mount, fire `refresh(…, "open")` once per selected workspace. When it settles, invalidate
  `projects.codeView(projectId)` and `projects.codeFiles(projectId, workspaceId, …)`.
- With more than one workspace, show a select whose value is kept in the `?workspace=` search param.
- Selecting a file renders `ProjectCodeFilePanel` beside the browser, or below it on narrow screens.

- [ ] **Step 1: Write the failing tests.** Mock `projectCodeViewApi`.
  - `ProjectCodeTab`:
    - it renders `main · 87d6557 "fix(web): a11y" · updated`;
    - `refresh` is called once with `"open"` on mount;
    - clicking `Update` calls `refresh` with `"manual"`;
    - `lastResult: "skipped_dirty"` shows the exact warning copy;
    - `{ workspaces: [] }` shows the empty-state copy.
  - `ProjectDetail`:
    - the tab list contains "Code" after "Tasks";
    - the path `/projects/:id/code` selects it.
- [ ] **Step 2:** Run both files with `--maxWorkers=2`. Expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Re-run both. Expect PASS. Run `pnpm --filter @paperclipai/ui typecheck` and `pnpm
  check:token-gates`, and expect exit 0.
- [ ] **Step 5:** Commit `feat(ui): project Code tab`.

### Task 8: Rollout to the live instance

- [ ] **Step 1:** Run the targeted checks again in the worktree:
  - every new or changed test file, one at a time;
  - server and ui typecheck;
  - token gates.
  Record the results.
- [ ] **Step 2:** Confirm no runs are active: `GET /api/companies/<QUA>/heartbeat-runs?limit=10` → nothing
  `running`/`queued`. Back up with `pnpm paperclipai db:backup` in `~/paperclip`.
- [ ] **Step 3:** In `~/paperclip`, run `git merge --ff-only feat/project-code-tab`, then wait for `/api/health`
  200.
- [ ] **Step 4:** Flag the live workspace: `PATCH /api/projects/62975b49-…/workspaces/5203bf9b-…` with `{ "metadata":
  { "codeView": { "enabled": true } } }`. Expect 200.
- [ ] **Step 5:** Verify:
  - take a Playwright screenshot of `/QUA/projects/tutor-booking-web/code`: the header shows `main · 87d6557`, and
    the root lists `apps`, `docs`, `e2e`;
  - open `README.md` and its content renders;
  - press `Update` and `lastResult` is `up_to_date`.
- [ ] **Step 6:** Report to the owner, with the screenshot path.
