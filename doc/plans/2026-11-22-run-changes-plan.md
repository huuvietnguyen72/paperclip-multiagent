# Run changes ("Changes" panel) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record, for every agent run that works in a local git workspace, which files changed (with red/green unified diffs) and which commands ran, and show them per run in a "Changes" tab of the task side panel. In the same delivery, enable the existing workspace file viewer ("view codebase") and give the owner a running preview of the product ("view product").

**Architecture:**
- A new `server/src/services/run-changes/` module owns everything:
  - git snapshots taken with a temporary index;
  - diffing the snapshots;
  - command extraction from the run log;
  - persistence;
  - a delivery worker.
- Heartbeat gains exactly one fire-and-forget call after workspace preparation (`recordRunStart`).
- End snapshots are taken by a worker that wakes on the existing `heartbeat.run.status` terminal live event. A new run on the same workspace also closes any still-open earlier capture, so nothing depends on the many settlement paths.

**Tech Stack:**
- Drizzle/Postgres (new tables plus migration);
- Express routes;
- Vitest with embedded Postgres;
- React side panel (`ui/src/components/task-side-panel/`);
- `git` CLI through `execFile`.

**Spec:** `doc/plans/2026-11-22-run-changes-design.md`

## Global Constraints

- **Capture must never fail or noticeably slow a run.**
  - Every capture error is logged and recorded as row status `failed` or `skipped`.
  - Each git snapshot is bounded at **20 s**.
- **Never touch the agent's git state:**
  - no index, branch, HEAD, stash or working-tree writes;
  - use `GIT_INDEX_FILE=<tmp>`;
  - ignored files (`.gitignore`) are never captured.
- **Limits:**
  - per file, **2,000 patch lines or 256 KB**, then `truncated: true`;
  - per run, **300 files** and **4 MB** total patch, after which the rest keep stats only;
  - binary files are recorded as `binary: true` with no patch;
  - commands: **200 max**, each **≤ 500 chars**.
- Patch text and command text pass through the run-log secret redaction before storage.
- `collapsedByDefault` is true for lockfiles (`package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `bun.lockb`, `Cargo.lock`, `poetry.lock`) and for files whose first 5 patch lines contain `@generated`, `auto-generated` or `DO NOT EDIT`.
- Only workspaces whose `providerType` is `local_fs` with a git `cwd` are captured. Everything else gets status `skipped` with reason `not_git` or `remote`.
- **Contract sync** (AGENTS.md §5.2): db schema plus export, then shared types, then server, then UI. Data path is the "run log" class (instance DB only), so no privacy review is needed.
- **Heartbeat rule:** `heartbeat.ts` grows by one call only; all logic lives in `services/run-changes/`.
- **UI:** tokens only (DESIGN.md); run `pnpm check:token-gates`. Labels in English.
- **Tests:** one vitest file at a time with `--maxWorkers=2` (the machine has little RAM). Never run full suites next to the live server.

## Review Focus

- **Two runs touching the same shared workspace at the same time.** The later run's capture must record `overlappingRunIds` and never crash. Pinned in Task 4.
- **Files with spaces, unicode (Vietnamese) names, renames and deletions.** Paths must round-trip exactly and the `?path=` lookup must find them. Pinned in Task 2 and Task 5.
- **A run whose workspace was deleted before finalization** (cleanup, crash). Status `incomplete`, no exception. Pinned in Task 4.
- **Huge generated diffs** such as `npm install` lockfile churn. Limits apply, the UI stays responsive, and lockfiles are collapsed. Pinned in Task 2 and Task 6.
- **A secret-looking token inside a changed tracked file or a command.** It must be redacted in storage. Pinned in Task 2 and Task 3.

---

### Task 1: Contracts and storage

**Files:**
- Create: `packages/shared/src/types/run-changes.ts` (export from `packages/shared/src/index.ts`)
- Create: `packages/db/src/schema/heartbeat_run_changes.ts` (export both tables from `packages/db/src/schema/index.ts`)
- Create: migration via `pnpm db:generate`

**Interfaces (Produces):**

```ts
export type RunChangeStatus = "pending" | "captured" | "no_changes" | "skipped" | "incomplete" | "failed";
export type RunChangeFileStatus = "added" | "modified" | "deleted" | "renamed";
export interface RunChangeFile { path: string; oldPath: string | null; status: RunChangeFileStatus; additions: number; deletions: number; binary: boolean; truncated: boolean; collapsedByDefault: boolean; }
export interface RunChangeCommand { ts: string | null; tool: string; text: string; }
export interface IssueRunChangesEntry {
  runId: string; agentId: string; agentName: string; runStatus: string; startedAt: string | null; finishedAt: string | null;
  status: RunChangeStatus; reason: string | null; additions: number; deletions: number;
  files: RunChangeFile[]; commands: RunChangeCommand[]; overlappingRunIds: string[]; branchChanged: boolean;
}
export interface RunChangeFilePatch { runId: string; path: string; patch: string | null; binary: boolean; truncated: boolean; }
export const RUN_CHANGES_LIMITS = { fileLines: 2000, fileBytes: 262144, files: 300, totalBytes: 4194304, commands: 200, commandChars: 500, snapshotTimeoutMs: 20000 } as const;
```

**Tables:**
- `heartbeat_run_changes`:
  - keys and relations: `id`; `company_id` (FK companies); `run_id` (FK heartbeat_runs, **unique**, on delete cascade); `issue_id` (nullable FK issues, set null); `agent_id` (FK agents); `execution_workspace_id` (nullable FK, set null);
  - workspace and state: `cwd` text; `status` text; `reason` text null;
  - snapshot SHAs: `start_head`, `start_tree`, `end_head`, `end_tree` (all text null);
  - totals and branch: `start_branch` text null; `end_branch` text null; `additions` int default 0; `deletions` int default 0;
  - json columns: `files` jsonb default `[]`; `commands` jsonb default `[]`; `overlapping_run_ids` jsonb default `[]`;
  - timestamps: `started_at` timestamptz; `finalized_at` timestamptz null; `created_at`; `updated_at`;
  - indexes: `(company_id, issue_id, created_at)`, `(execution_workspace_id, status)`.
- `heartbeat_run_change_files`:
  - columns: `id`; `run_change_id` (FK cascade); `path` text; `patch` text null;
  - unique on `(run_change_id, path)`.

- [ ] **Step 1:** Write the shared types and constants above, then add the export.
- [ ] **Step 2:** Write the schema file, mirroring `issue_work_products.ts` style, then add both exports to the schema index.
- [ ] **Step 3:** Run `pnpm db:generate`. Expected: one new migration `0433_*.sql` creating both tables and indexes, and no other diff.
- [ ] **Step 4:** Run `pnpm --filter @paperclipai/db typecheck && pnpm --filter @paperclipai/shared typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(db): run changes tables and contracts`.

### Task 2: Git snapshot and diff

**Files:**
- Create: `server/src/services/run-changes/git-snapshot.ts`
- Test: `server/src/services/run-changes/git-snapshot.test.ts` (temp repos via `mkdtemp` and `git init`; no DB)

**Interfaces (Produces):**

```ts
export type Snapshot = { head: string | null; tree: string; branch: string | null };
export type SnapshotResult = { ok: true; snapshot: Snapshot } | { ok: false; reason: "not_git" | "timeout" | "error"; detail?: string };
export async function captureSnapshot(cwd: string, opts?: { timeoutMs?: number }): Promise<SnapshotResult>;
export async function diffSnapshots(cwd: string, start: Snapshot, end: Snapshot, redact: (text: string) => string):
  Promise<{ files: RunChangeFile[]; patches: Map<string, string | null>; additions: number; deletions: number }>;
export function isCollapsedByDefault(path: string, patchHead: string): boolean;
```

**Approach:**
- *Snapshot:*
  1. `git rev-parse --show-toplevel` (failure means `not_git`).
  2. HEAD via `rev-parse HEAD` (null if the repo is unborn); branch via `symbolic-ref --short -q HEAD`.
  3. Using the temp index: `read-tree HEAD`, or `read-tree --empty` if unborn; then `add -A`; then `write-tree`. Run with `env: { ...process.env, GIT_INDEX_FILE: tmp }`. Delete the temp file in `finally`.
  4. Apply the overall `AbortSignal` timeout.
- *Diff:* `git diff --numstat -z -M <a> <b>`, then `git diff --name-status -z -M`, then one `git diff -M --patch <a> <b> -- <path>` per kept file. `-z` keeps unicode and space paths exact.

**Steps:**
- [ ] **Step 1:** Write failing tests:
  - `captures modified, added, deleted and renamed files`: counts and statuses exact; rename has `oldPath`.
  - `includes commits made during the run`: commit between snapshots, the diff still shows the file.
  - `ignores gitignored files`: a `.env` added and `.gitignore` containing `.env` gives no `.env` entry.
  - `does not touch the agent index, HEAD or branch`: staged change before capture means `git diff --cached` output is identical after both captures, and HEAD and branch are unchanged.
  - `round-trips unicode and space paths`: `docs/Báo cáo cuối kỳ.md`.
  - `marks binary files`: a PNG gives `binary: true`, patch null.
  - `truncates big files and enforces run limits`: a 3,000-line file gives `truncated: true` and the stored patch has ≤ 2,000 lines; 305 files keeps stats for all, patches only for 300.
  - `collapses lockfiles and generated files`.
  - `redacts secrets in patches`: a line `API_KEY=sk-live-...` in a tracked file goes through `redact`.
  - `returns not_git for a plain directory`; `returns timeout when git hangs`, simulated with `timeoutMs: 1` on a large add.
- [ ] **Step 2:** Run `pnpm --filter @paperclipai/server exec vitest run src/services/run-changes/git-snapshot.test.ts --maxWorkers=2`. Expected: FAIL (module missing).
- [ ] **Step 3:** Implement the module.
- [ ] **Step 4:** Re-run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(server): git snapshots and diffs for run changes`.

### Task 3: Command extraction from run logs

**Files:**
- Create: `server/src/services/run-changes/commands.ts`
- Test: `server/src/services/run-changes/commands.test.ts`, with small synthetic fixtures copied in shape from the real logs below.

**Interfaces:**
- *Produces:* `export function extractRunCommands(ndjson: string, redact: (t: string) => string): RunChangeCommand[]`.
- *Input format:* each NDJSON line is `{ts, stream, chunk}`, where `chunk` holds one or more JSON lines.

| Format | Event | Map to |
|---|---|---|
| Claude ACP | `{"type":"acpx.tool_call","title":"<command>","kind":"Terminal"|...}` | `{ts: line.ts, tool: kind ?? "tool", text: title}` |
| OpenCode | `{"type":"tool_use","timestamp":<ms>,"part":{"tool":"bash"|"edit"|"write"|...,"state":{"input":{...}}}}` | `text` = `input.command ?? input.filePath ?? JSON.stringify(input)` |

- Drop tools: `read`, `glob`, `grep`, `list`, `ToolSearch`, `skill`, `todowrite`, `webfetch`.
- Ignore duplicate `tool_call` updates (same title within the same tool-call id when present).
- Cap per the global limits.

**Steps:**
- [ ] **Step 1:** Failing tests:
  - `extracts ACP terminal commands in order`;
  - `extracts OpenCode bash and edit tools with file paths`;
  - `drops read-only tools`;
  - `truncates long commands to 500 chars`;
  - `caps at 200 commands`;
  - `redacts secrets` (`export GH_TOKEN=ghp_xxx` is redacted);
  - `tolerates malformed lines`.
- [ ] **Step 2:** Run that file. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(server): extract run commands for run changes`.

### Task 4: Run changes service, worker and heartbeat hook

**Files:**
- Create: `server/src/services/run-changes/service.ts`, `server/src/services/run-changes/worker.ts`, `server/src/services/run-changes/index.ts`
- Modify: `server/src/services/delivery-work-notifications.ts` (add `runChanges: "run-changes"` to `DELIVERY_QUEUES`)
- Modify: `server/src/index.ts` (register the worker next to `registerCostAccountingWork`; stop it on `close`)
- Modify: `server/src/services/heartbeat.ts`. Add one call right after `prepareHeartbeatWorkspace(...)` resolves:
  `void runChanges.recordRunStart({ run, executionWorkspace, persistedExecutionWorkspace, executionTarget, issueId }).catch(logRunChangesError)`
  (construct `runChanges = createRunChangesService(db)` in the heartbeat factory).
- Test: `server/src/services/run-changes/service.test.ts` (embedded Postgres, pattern of `model-fallback/service.test.ts`; temp git repo as the workspace `cwd`).

**Interfaces (Produces):**

```ts
export function createRunChangesService(db: Db, deps?: { now?: () => Date; readRunLog?: (run) => Promise<string> }): {
  recordRunStart(input: { run: { id: string; companyId: string; agentId: string; startedAt: Date | null };
    executionWorkspace: { cwd: string }; persistedExecutionWorkspace: { id: string; providerType: string } | null;
    executionTarget: { kind: string } | null; issueId: string | null }): Promise<void>;
  finalizeRun(runId: string): Promise<void>;               // idempotent; end snapshot, diff, commands, persist
  finalizePending(): Promise<number>;                       // all pending rows whose run is terminal
  listForIssue(companyId: string, issueId: string): Promise<IssueRunChangesEntry[]>;
  getFilePatch(companyId: string, runId: string, path: string): Promise<RunChangeFilePatch | null>;
};
export function registerRunChangesWork(db: Db, coordinator: Coordinator): { ready: Promise<void>; stop(): void };
```

**Behaviour:**
- `recordRunStart`:
  - Remote target or no persisted local workspace: insert `skipped`.
  - Otherwise, first **finalize** any `pending` row on the same `execution_workspace_id` from another run, using this new snapshot as that row's end.
  - Then take the start snapshot and insert `pending`. Record `overlappingRunIds` on both rows when the other run was still non-terminal.
- `finalizeRun`:
  - Workspace `cwd` missing: `incomplete`.
  - Otherwise take the end snapshot, diff it, read the run log through `getRunLogStore().read({store: run.logStore, logRef: run.logRef})`, extract commands, then upsert the patches.
  - Set `captured` or `no_changes`. Set `branchChanged` when `start_branch !== end_branch`.
- The worker wakes on `heartbeat.run.status` with a terminal status (`succeeded`, `failed`, `timed_out`, `cancelled`, `interrupted`) and calls `finalizePending()`. `hasPending` returns whether any pending row's run is terminal.
- The redactor is the run-log redaction already used for run log chunks (`run-log.ts`). Reuse it; do not write a new one.

**Steps:**
- [ ] **Step 1:** Failing tests:
  - `records start and finalizes a captured run with files and commands`;
  - `finalize is idempotent`;
  - `skips remote and non-git workspaces`;
  - `marks incomplete when the workspace was deleted`;
  - `a new run on the same workspace closes the previous pending capture and records overlap`;
  - `listForIssue returns newest first with agent names and totals and only that issue's runs`;
  - `getFilePatch is company scoped and finds unicode paths`.
- [ ] **Step 2:** Run the file. Expected: FAIL.
- [ ] **Step 3:** Implement the service, worker and wiring.
- [ ] **Step 4:** Run `service.test.ts`. Expected: PASS. Run `pnpm --filter @paperclipai/server typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(server): capture run changes around heartbeat runs`.

### Task 5: API routes

**Files:**
- Modify: `server/src/routes/issues.ts`. Add next to `/issues/:id/work-products`, with the same `getAccessibleResource` and `assertIssueReadAllowed` guard:
  - `GET /issues/:id/run-changes` returns `IssueRunChangesEntry[]`.
  - `GET /issues/:id/run-changes/:runId/file?path=` returns `RunChangeFilePatch`, or 404 when the run does not belong to this issue or the path is not in the run.
  - Scoping the file route under the issue reuses its access guard.
- Test: route tests in the style of `model-fallback` route tests: cross-company 404, unknown run 404, path not in run 404, unicode path 200.

- [ ] **Step 1:** Write failing route tests.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement the routes.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(server): run changes routes`.

### Task 6: UI "Changes" tab in the task side panel

**Files:**
- Modify: `ui/src/api/issues.ts`. Add `listRunChanges(issueId)` and `getRunChangeFile(issueId, runId, path)`, plus query keys in `ui/src/lib/queryKeys.ts`.
- Create: `ui/src/lib/unified-patch.ts`:
  - `parseUnifiedPatch(patch: string): PatchHunk[]`;
  - `PatchHunk = { header: string; lines: { kind: "context" | "add" | "del"; oldNo: number | null; newNo: number | null; text: string }[] }`.
- Create: `ui/src/components/task-side-panel/TaskRunChangesPanel.tsx`:
  - a run list, newest first;
  - each run expands to a "Commands run (n)" disclosure and a file list with status letter and `+a −d`;
  - clicking a file loads and renders the hunks: two line-number columns, `+`/`−` gutter, add/del background tokens, and runs of more than 6 unchanged context lines folded to "… N unchanged lines";
  - collapsed-by-default files show a one-line "collapsed" row;
  - notes for overlap and branch change;
  - status rows for `skipped`, `incomplete` and `failed`; `no_changes` runs grouped into a single muted line;
  - an empty state.
- Modify: `ui/src/components/task-side-panel/TaskSidePanel.tsx`. Add launcher item `{ id: "changes", label: "Changes", icon: <GitCompare /> }` after Artifacts, a payload kind `"changes"`, and render `TaskRunChangesPanel`.
- Test: `ui/src/lib/unified-patch.test.ts` and `TaskRunChangesPanel.test.tsx`.

**Steps:**
- [ ] **Step 1:** Failing tests:
  - patch parser: hunk header numbering, add/del/context numbering, `\ No newline at end of file` ignored;
  - panel: renders runs and totals, opens a file and shows a `del` row and an `add` row, folds long context, collapsed lockfile row, empty state, overlap note.
- [ ] **Step 2:** Run each file. Expected: FAIL.
- [ ] **Step 3:** Implement, using existing diff colour tokens (see how `DocumentDiffModal.tsx` colours rows) and existing side-panel layout primitives.
- [ ] **Step 4:** Run the tests and `pnpm check:token-gates`. Expected: PASS. Run `pnpm --filter @paperclipai/ui typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(ui): Changes tab in the task side panel`.

### Task 7: Live verification, codebase viewer and product preview

- [ ] **Step 1:** Start an isolated dev instance from the worktree on port 3101 (as done for model fallback). Create a test task for an agent whose workspace is a git repo. Let it edit files through the terminal. Open the task, then Changes, and confirm files, red/green rows and commands. Take a screenshot.
- [ ] **Step 2:** Whole-branch review, then fix findings. Run the focused tests again.
- [ ] **Step 3:** Merge into live:
  - back up the DB (`pnpm paperclipai db:backup`);
  - make sure no runs are active;
  - fast-forward `~/paperclip` master;
  - restart the server with `PAPERCLIP_CHAT_WEBHOOK_PUBLIC_URL`, the webhook gate and ngrok;
  - confirm health and that migration `0433` applied.
- [ ] **Step 4:** View codebase: enable the instance experimental setting `enableExperimentalFileViewer`, then confirm the task side panel shows "Files" and browses the workspace.
- [ ] **Step 5:** View product:
  - start Docker Desktop;
  - clone or refresh `~/tutorbooking` from `main`;
  - run `./scripts/init-env.sh` if `.env` is missing, then `docker compose up -d --build`;
  - wait until healthy;
  - confirm `http://localhost:8080/api/v1/health` returns `{"status":"ok"}`;
  - screenshot the home page.
- [ ] **Step 6:** Report back with screenshots and where each feature lives.
