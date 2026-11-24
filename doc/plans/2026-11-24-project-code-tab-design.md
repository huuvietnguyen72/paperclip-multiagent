# Project "Code" tab — design

Date: 2026-11-24. Status: approved by the owner ("hãy làm theo ý của bạn").

## Intent

The board wants to read the whole codebase of a project inside Paperclip, without going through one task's file
panel. The code shown must be current: after an agent finishes a task, the board should see the merged result.

Today the only file browser is the task side panel (`WorkspaceFileBrowser`, issue-scoped API
`/issues/:id/file-resources/*`). It shows the task's execution workspace. The project's primary workspace for
TutorBooking is a GitHub URL, which Paperclip reports as "Remote workspace preview not supported". On 2026-11-24 a
second, non-primary project workspace was added: "Codebase (local main)" (`local_path`, cwd
`/home/huuvietnguyen/tutorbooking`, a clone of `main`). That clone does not update itself.

## Goals

1. A **Code** tab on the project page (`/projects/:projectId/code`) that browses a local project workspace from its
   root: folders, file content and search. It is read-only.
2. The tab shows which code you are looking at: the branch, the short commit, its subject, and when it was last
   updated.
3. The clone stays current without anyone doing anything:
   - it is pulled when a task in the project becomes `done`;
   - it is pulled (throttled) when the tab is opened;
   - an **Update** button pulls on demand.

## Non-goals

- Editing files, committing or switching branches from the tab.
- Browsing GitHub or other remote workspaces directly.
- Showing diffs. The task "Changes" tab already does that.
- Pulling execution workspaces or any workspace an agent works in.

## Anti-goals (a failure even if it "works")

- Spending an agent run (LLM tokens) to run `git pull`. The owner asked whether an agent could do it. We chose a
  server-side pull instead: it is free, it is reliable, and agents cannot reach this path anyway.
- Changing where agents execute. The local workspace stays non-primary, and nothing here touches workspace selection.
- Destroying local changes. The pull is fast-forward only, never resets, and never runs on a dirty tree.

## Approaches considered

| Approach | Trade-off | Decision |
|---|---|---|
| A. Server auto-update: pull on task `done`, on tab open (throttled) and with a button | No tokens, immediate, deterministic. Needs a small server worker. | **Picked** |
| B. Assign an agent (e.g. DevOps) to `git pull` after each task | Costs a full LLM run per pull. Unreliable: the agent may forget or get stuck. The agent sandbox may not reach the path. | Rejected |
| C. OS cron `git pull` every N minutes | Simple, but outside Paperclip. Lag of up to N minutes. Not visible in the UI. | Rejected |

## Design

### Which workspaces the tab shows and auto-updates

- **Opt-in flag.** A project workspace takes part only when its jsonb `metadata.codeView.enabled === true`. The flag
  needs no migration. Without it, an operator's local workspace (maybe with uncommitted work) would get pulled
  unexpectedly.
- **Tab contents.** The tab lists the project's workspaces that have this flag and a non-empty `cwd`.
  - With one workspace, there is no selector.
  - With several, a small selector appears. Its value is kept in the `?workspace=` query parameter.
  - With none, an empty state explains how to add one, with a link to the Workspaces tab.
  - The `metadata` field is already writable through `PATCH /projects/:id/workspaces/:workspaceId`. A UI toggle on
    the workspace page is a nice-to-have and not required (builder's call). The existing "Codebase (local main)"
    workspace gets the flag via the API as part of rollout.

### Server

**1. Project-scoped file routes** (board only, company access check; same audit and denial logging style as the
issue routes):
- `GET /projects/:projectId/workspaces/:workspaceId/file-resources/list`: same query as the issue list (`path`,
  `q`, `mode`, `limit`, `offset`).
- `GET /projects/:projectId/workspaces/:workspaceId/file-resources/content?path=`
- Implementation: refactor `workspaceFileResourceService.list` and `readContent` so they accept a scope that is
  either an issue or `{ companyId, projectId, workspaceId }`. Today the issue only supplies `companyId` once an
  explicit project and workspace target is given (`targetProjectWorkspaceCandidate`). Keep the issue routes'
  behaviour identical.
- The workspace must have `metadata.codeView.enabled`; otherwise return 404. This keeps the route from becoming a
  general file reader for every project workspace.
- **Root listing.** In "all" mode the browser needs the children of the workspace root. Today it lists a folder only
  when `path` is set, and `"."` is rejected. Make a root listing possible, for example with an explicit
  `path=""`/`root=1`. Builder's call, with a test.

**2. Code-view state and refresh.** New service `server/src/services/project-code-view.ts`:
- `status(workspace)`: branch, HEAD sha (short) and subject, plus `lastUpdatedAt`, `lastResult` and `lastError` from
  `metadata.codeView`.
- `refresh(workspace, { reason })`:
  1. Run `git -C <cwd> fetch --quiet origin`.
  2. If the tree is clean (`status --porcelain`) and HEAD is on a branch with an upstream, run
     `merge --ff-only @{upstream}`.
  3. Otherwise record `lastResult: "skipped_dirty"`, `"skipped_detached"` or `"diverged"`. Never use reset, stash or
     checkout.
  4. Record the result in `metadata.codeView` (`lastUpdatedAt`, `lastResult`, `head`, `lastError`, truncated and
     redacted).
- Safety:
  - Fixed argument arrays, no shell, timeout of about 60 s.
  - One refresh per workspace at a time; a second caller waits for the first or gets its result.
  - Throttle: requests with `reason: "open"` within 60 s of the last refresh are no-ops.
- Endpoints:
  - `GET /projects/:projectId/workspaces/:workspaceId/code-view`: status plus head info.
  - `POST /projects/:projectId/workspaces/:workspaceId/code-view/refresh`: board only. The body is
    `{ reason: "open" | "manual" }`. It returns the new status.
- Activity log: `project_workspace.code_refreshed` for manual refreshes, and for automatic ones only when HEAD moved.
  This avoids a log row per tab open.

**3. Auto-refresh on task done.**
- A worker subscribes to `activity.logged` live events (the same pattern as `run-changes/worker.ts`). It reacts
  when `entityType === "issue"`, `action === "issue.updated"` and `details.status === "done"`.
- It looks up the issue's `projectId`, then refreshes every flagged workspace of that project (`reason: "task_done"`).
- Fire-and-forget with error logging. It never blocks or fails the issue update.
- A merged PR usually precedes `done` in this team's workflow (the Tech Lead merges, then the task closes), so the
  pull picks up the merge. The tab-open refresh and the Update button cover the remaining cases.

### UI

- `ProjectDetail.tsx`: add `"code"` to `ProjectBaseTab`, the `/code` route segment and the tab trigger "Code",
  placed after Issues. Route it in `App.tsx` alongside the other project tabs.
- New `ProjectCodeTab` component:
  - Header row: `main · 87d6557 "fix(web): …" · updated 21:40` and an **Update** button (with a spinner while
    running).
  - A muted warning line when `lastResult` is `skipped_dirty`, `diverged` or an error.
  - When the tab opens, fire `refresh({ reason: "open" })` in the background. The list shows immediately and
    re-queries after the refresh finishes.
  - Body: reuse `WorkspaceFileBrowser` and the file viewer. Generalize the API client and browser props from
    `issueId` to a scope `{ kind: "issue", issueId } | { kind: "project", projectId, workspaceId }`. This is a
    prop-level change; issue behaviour stays the same.
  - The project scope always uses "all" mode starting at the root, never "changed" mode.
- UI strings are English, like the rest of the board UI (owner preference). Token-only styling, checked with
  `pnpm check:token-gates`.

## Constraints

- Company scoping is enforced on every route, and agents are denied (board only), matching the existing
  file-resource routes.
- Contracts:
  - shared: types for the code-view status and the list scope;
  - server: routes and services;
  - ui: the API client.
  - No DB migration (jsonb metadata).
- Tests are vitest, run one file at a time with `--maxWorkers=2`. Never run the full suite next to the live server.
- Development happens in the worktree `~/paperclip-code-tab` on branch `feat/project-code-tab`. It merges into live
  `~/paperclip` only after a DB backup, with no runs in flight.

## Left to the builder

- The exact refactor shape of the scope in `workspaceFileResourceService`.
- How the root listing is expressed.
- Whether to add a workspace-page toggle for `codeView.enabled`.
- The concurrency primitive for the per-workspace refresh lock.

## Calls made by Claude (owner may override)

- The opt-in `metadata.codeView.enabled` flag, rather than auto-pulling every local workspace.
- The 60 s open-throttle and the fast-forward-only, clean-tree-only pull policy.
- The tab is called "Code" and sits after "Issues".
