# Team Feed Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only "Team feed" page. It shows every task status change as a chat-like message with the actor,
the task, `from → to`, the agent's latest note and the files changed (`+a −b`).

**Architecture:** A read model; nothing new is written.
- A pure derivation module does status parsing, note excerpts, run-to-event attribution and file summaries.
- A service runs batched queries over `activity_log`, `issues`, `issue_comments`, `agents`, `heartbeat_run_changes` and
  `heartbeat_runs`, filtered by `issueReadSqlCondition`.
- A company route exposes the feed.
- A React page shows it, with live invalidation and pending polling.

**Tech Stack:** TypeScript, Express, Drizzle (embedded Postgres tests), React + TanStack Query, Vitest.

**Spec:** `doc/plans/2026-11-25-team-feed-design.md`

## Global Constraints

**Data and access**
- No new tables, migrations or writes. No LLM calls.
- Source rows are `activity_log` rows with `entity_type = 'issue'`, `action = 'issue.updated'` and `details->>'status'`
  present.
- The previous status is the first present of `details.changes.status.from`, `details._previous.status` and
  `details.previousStatus`. Rows where from equals to are skipped.
- Order is `created_at desc, id desc`. The cursor `before` is `<ISO createdAt>|<id>`. `limit` defaults to 30 and the
  maximum is 100.
- Every query is company-scoped, and issue visibility uses `issueReadSqlCondition(db, req.actor)`.

**Message content**
- Actor names: agent → the agent's name; user → `"Board"`; system → `"System"`.
- Reason: `details.source`, unless it is `undefined`, `"comment"` or `"update"`.
- The note is the latest comment by an agent with `created_at <= event + 5000 ms` and `>=` the issue's previous status
  event time. Markdown is stripped to plain text and truncated to 280 chars with `…`.
- Changes for `to === "done"`: all captured runs of the issue with `started_at <= event`.
- Changes for other statuses: runs attributed to this event. Each run belongs to the issue's latest status event at
  or before the run's end (`heartbeat_runs.finished_at`, falling back to `finalized_at`). A run that ended before the
  first event goes to the first event. A run without an end goes to the latest event.
- `pending` is true when a counted run has a capture row with status `pending`.
- File summary: per path, sum additions and deletions; take the top 5 by `additions + deletions`, plus `totalFiles`,
  `additions` and `deletions` over all paths. `changes` is null when no run is attributed.

**UI**
- Route `/team-feed`, with sidebar label `Team feed` right after Inbox. English strings, token-only styling.
- Live: invalidate the feed's first page on `activity.logged` with an issue status change, and on a terminal
  `heartbeat.run.status`. Poll every 15 000 ms while any visible item has `changes.pending`.

**Process**
- Tests: run vitest one file at a time with `--maxWorkers=2`.
- Commits: end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never push.

## Review Focus

1. **A status change by recovery or System** with `previousStatus` only, and no `changes`. Expected: the from status
   is shown and the actor is "System". Covered in Task 2.
2. **An agent marks done while its run is still running.** Expected: the done message includes that run (started
   before the event) and `pending: true`. Covered in Task 3.
3. **A private task the viewer cannot read.** Expected: it never appears, and the page still fills up to `limit`.
   Covered in Task 3.
4. **A huge comment, or one full of Markdown** (code fences, links). Expected: plain text of at most 281 chars. Covered
   in Task 2.
5. **Two events with the same `created_at`** across a page boundary. Expected: no duplicate and no gap, because of the
   `(createdAt, id)` cursor. Covered in Task 3.

---

### Task 1: Shared team feed types

**Files:**
- Create: `packages/shared/src/team-feed.ts`
- Modify: `packages/shared/src/index.ts` (add the export)

**Interfaces — Produces:**
```ts
export interface TeamFeedFileChange { path: string; additions: number; deletions: number; binary: boolean }
export interface TeamFeedChanges { totalFiles: number; additions: number; deletions: number; pending: boolean; files: TeamFeedFileChange[] }
export interface TeamFeedItem {
  id: string; at: string;
  actor: { kind: "agent" | "board" | "system"; agentId: string | null; name: string };
  reason: string | null;
  issue: { id: string; identifier: string | null; title: string };
  fromStatus: string | null; toStatus: string;
  note: string | null;
  changes: TeamFeedChanges | null;
}
export interface TeamFeedResponse { items: TeamFeedItem[]; nextCursor: string | null }
export const TEAM_FEED_DEFAULT_LIMIT = 30;
export const TEAM_FEED_MAX_LIMIT = 100;
export const TEAM_FEED_TOP_FILES = 5;
export const TEAM_FEED_NOTE_MAX_CHARS = 280;
export const TEAM_FEED_PENDING_POLL_MS = 15_000;
```

This task has types and constants only. It has no behaviour to test; Task 2 covers its use.

- [ ] **Step 1:** Create the module and add the export.
- [ ] **Step 2:** Run `pnpm --filter @paperclipai/shared typecheck`. Expect exit 0.
- [ ] **Step 3:** Commit `feat(shared): team feed types` (together with Task 2).

### Task 2: Pure derivation helpers

**Files:**
- Create: `server/src/services/team-feed/derive.ts`
- Test: `server/src/services/team-feed/derive.test.ts`

**Interfaces:**
- Consumes: Task 1 types.
- Produces:
```ts
export function readStatusChange(details: unknown): { from: string | null; to: string } | null; // null when no status or from === to
export function actorFor(row: { actorType: string; agentId: string | null }, agentNames: Map<string, string>): TeamFeedItem["actor"];
export function reasonFor(details: unknown): string | null;
export function noteExcerpt(markdown: string): string;            // plain text, ≤ TEAM_FEED_NOTE_MAX_CHARS + "…"
export interface FeedRun { runId: string; startedAt: Date; endedAt: Date | null; status: string /* capture status */; files: Array<{ path: string; additions: number; deletions: number; binary: boolean }> }
export interface FeedStatusEvent { id: string; at: Date; to: string }
/** Map event id → runs shown under that event, following the spec's done/step rules. events sorted ascending by time. */
export function attributeRuns(events: FeedStatusEvent[], runs: FeedRun[]): Map<string, FeedRun[]>;
export function summarizeChanges(runs: FeedRun[]): TeamFeedChanges | null;
```

- [ ] **Step 1: Write the failing tests.**
  - `readStatusChange`:
    - `{status:"done", changes:{status:{from:"in_progress",to:"done"}}}` → `{from:"in_progress",to:"done"}`;
    - `{status:"todo", _previous:{status:"blocked"}}` → from `blocked`;
    - `{status:"blocked", previousStatus:"todo"}` → from `todo`;
    - `{status:"todo"}` → `{from:null,to:"todo"}`;
    - `{status:"done", changes:{status:{from:"done"}}}` → `null`;
    - `{}` and `null` → `null`.
  - `actorFor`:
    - `{actorType:"agent", agentId:"a1"}` with names `a1→"FE"` → `{kind:"agent",agentId:"a1",name:"FE"}`;
    - `user` → `{kind:"board",agentId:null,name:"Board"}`;
    - `system` → `"System"`;
    - an agent missing from the map → name `"Agent"`.
  - `reasonFor`: `{source:"comment"}` → null; `{source:"recovery.reconcile_configuration_incomplete"}` → that string;
    `{}` → null.
  - `noteExcerpt`:
    - `"**Đã** thêm [trang](http://x) \`code\`\n\n- mục"` → `"Đã thêm trang code mục"`;
    - code fences are removed, leaving their text content;
    - a 1000-char input → length `281`, ending with `"…"`.
  - `attributeRuns` (times as minutes):
    - events e1 (t=0, in_progress), e2 (t=10, in_review), e3 (t=20, done);
    - runs: r1 start −1, end 12; r2 start 15, end 18; r3 start 19, end null (pending);
    - expected:
      - e1 → `[]`;
      - e2 → `[r1, r2]` (both ended after e2 and before e3);
      - e3 (done) → `[r1, r2, r3]` (all started ≤ 20).
    - A run ending before e1 goes to e1.
    - A run with no end and status `captured` goes to the latest event.
  - `summarizeChanges`:
    - the same path in two runs is summed;
    - 7 paths → `files.length === 5`, sorted by `additions + deletions` desc, `totalFiles === 7`;
    - a pending run → `pending: true`;
    - `[]` → `null`.
- [ ] **Step 2:** Run `cd server && npx vitest run src/services/team-feed/derive.test.ts --maxWorkers=2`. Expect FAIL.
- [ ] **Step 3:** Implement. `noteExcerpt` uses regex stripping (code fences, inline code, links `[t](u)`→`t`, emphasis,
  headings, list markers), then collapses whitespace.
- [ ] **Step 4:** Re-run. Expect PASS.
- [ ] **Step 5:** Commit `feat(server): team feed derivation helpers` (this includes Task 1).

### Task 3: Team feed service

**Files:**
- Create: `server/src/services/team-feed/service.ts` and `index.ts`
- Test: `server/src/services/team-feed/service.test.ts`

**Interfaces:**
- Consumes: Task 2 helpers.
- Produces:
```ts
export function createTeamFeedService(db: Db): {
  list(input: { companyId: string; readCondition: SQL<boolean>; before?: string | null; limit?: number }): Promise<TeamFeedResponse>;
};
export function parseTeamFeedCursor(value: unknown): { at: Date; id: string } | null; // throws badRequest on malformed
```

**Query plan (batched; no per-row queries):**
1. Read the page: `activity_log` inner join `issues` on `issues.id::text = activity_log.entity_id`. Filter on company,
   the source-row rules, `readCondition` and the cursor `(created_at, id) < (at, id)`. Order desc, `limit + 1` rows.
   Skip rows where `readStatusChange` returns null. If a page is then short and more rows exist, keep reading until it
   is full.
2. For the page's issue ids, read all their status events (same filter, ascending) to get `FeedStatusEvent[]` per
   issue.
3. Read the agent names for actor agent ids.
4. Read the latest agent comments per issue, with `created_at <=` the page's max event + 5 s. Pick the comment per event
   in memory, applying the note rule.
5. Read the run captures for those issues: `heartbeat_run_changes` left join `heartbeat_runs`, giving `started_at`,
   `coalesce(heartbeat_runs.finished_at, finalized_at)`, status and files. Then apply `attributeRuns` and
   `summarizeChanges`.
6. `nextCursor` is the last item's `at|id` when more rows exist, otherwise null.

- [ ] **Step 1: Write the failing tests.** Use embedded Postgres. Seed:
  - one company and one other company;
  - agents FE and PM;
  - issues QUA-1 (open) and QUA-2 (private, readable only through a condition that excludes it);
  - activity rows:
    - FE: in_progress at t0, in_review at t10, done at t20, all on QUA-1;
    - a system row `blocked` with only `previousStatus:"todo"` on QUA-1 at t5;
    - a row without a status;
    - a row where from equals to;
  - FE comments at t9 ("**Xong** phần API") and at t19.5;
  - runs and captures:
    - r1 (start t−1, end t12, captured, `apps/api/a.ts +10 −2`);
    - r2 (start t19, no end, pending).

  Tests:
  - newest first, and the skipped rows are absent;
  - `actor.name` is `"FE"`, `"System"` and `"Board"` as appropriate;
  - the done item has changes including `apps/api/a.ts` and `pending: true`;
  - the in_review item has changes from r1 only, `pending: false`;
  - the in_progress item has `changes: null`;
  - the note on in_review is `"Xong phần API"`; the note on done is the t19.5 comment;
  - the system blocked item has `fromStatus: "todo"` and reason `"recovery.reconcile_configuration_incomplete"`;
  - with `readCondition` excluding QUA-2, no QUA-2 item appears and `limit: 2` still returns 2 items;
  - cursor paging with `limit: 2` over 4 items yields 2 + 2 with no duplicate, including two rows with equal
    `created_at`;
  - the other company's rows are never returned;
  - `parseTeamFeedCursor("bad")` throws status 400.
- [ ] **Step 2:** Run `npx vitest run src/services/team-feed/service.test.ts --maxWorkers=2`. Expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Re-run. Expect PASS. Run the server typecheck and expect exit 0.
- [ ] **Step 5:** Commit `feat(server): team feed read model`.

### Task 4: Team feed route

**Files:**
- Create: `server/src/routes/team-feed.ts`
- Modify: `server/src/app.ts` (mount it)
- Test: `server/src/__tests__/team-feed-routes.test.ts`

**Interfaces — Produces:** `teamFeedRoutes(db: Db): Router`, with `GET /companies/:companyId/team-feed?before=&limit=` →
`TeamFeedResponse`.

**Route behaviour:**
- `assertCompanyAccess(req, companyId)`.
- `readCondition = await issueReadSqlCondition(db, req.actor)`.
- `limit` is clamped to `[1, 100]` (default 30). A non-numeric `limit` falls back to 30.

- [ ] **Step 1: Write the failing tests.** Use embedded Postgres and supertest.
  - A board member of the company → 200 with `items` and `nextCursor`.
  - A board user without company access → 403.
  - `before=bad` → 400.
  - `limit=500` → returns at most 100 items (seed 3 rows and assert 3 are returned without error).
- [ ] **Step 2:** Run it and expect FAIL. **Step 3:** Implement and mount. **Step 4:** Re-run and expect PASS; run
  the server typecheck and expect 0.
- [ ] **Step 5:** Commit `feat(server): team feed route`.

### Task 5: Team feed page, sidebar entry and route

**Files:**
- Create:
  - `ui/src/api/team-feed.ts`: `teamFeedApi.list(companyId, { before?, limit? }): Promise<TeamFeedResponse>`;
  - `ui/src/pages/TeamFeed.tsx`;
  - `ui/src/pages/TeamFeed.test.tsx`.
- Modify:
  - `ui/src/lib/queryKeys.ts`: `teamFeed: (companyId: string) => ["team-feed", companyId] as const`;
  - `ui/src/App.tsx`: add `<Route path="team-feed" element={<TeamFeed />} />` next to the `decisions` route;
  - `ui/src/components/Sidebar.tsx` and `Sidebar.production.tsx`: add `<SidebarNavItem to="/team-feed" label="Team
    feed" icon={Newspaper} />` right after the Inbox item, outside its condition.

**Page:**
- Data: `useInfiniteQuery` keyed by `queryKeys.teamFeed(companyId)`, with `getNextPageParam: (page) =>
  page.nextCursor`. `refetchInterval` is 15 000 ms when any loaded item has `changes?.pending`, otherwise false.
- `useCompanyLiveEvent`: invalidate `queryKeys.teamFeed(companyId)` on `activity.logged` where `payload.entityType ===
  "issue"` and `payload.details?.status`, and on `heartbeat.run.status` with a terminal status.
- Each card:
  - `AgentAvatar` (for agents) or an initial;
  - the actor name;
  - a task link `/issues/{identifier}` showing `{identifier} {title}`;
  - `StatusBadge` for from, `→`, and `StatusBadge` for to;
  - the time via `timeAgo`, with the absolute time in `title`;
  - the reason as small muted text when present;
  - the note in muted text;
  - the files as a monospace list `path  +a −b`, with green and red token classes as in `TaskRunChangesPanel`;
  - then `… {totalFiles − files.length} more files · View changes`. The link points to the task URL with
    `?panel=changes`, or whatever the side panel uses to open the Changes tab (follow `taskPanelChangesTab`'s URL
    state). If no URL state exists, link to the task.
  - `changes.pending` → the line "Changes are still being recorded…".
- States:
  - loading: "Loading team feed…";
  - empty: "No task updates yet.";
  - error: `describeError(err, { action: "load the team feed" }).body`;
  - a "Load older" button while `hasNextPage`.

- [ ] **Step 1: Write the failing tests.** Mock `teamFeedApi`, and render inside a QueryClient and MemoryRouter.
  - A done item renders:
    - `"FE"`, `"QUA-57"`, the task title, the from and to labels;
    - the note;
    - `apps/web/src/A.tsx`, `+120`, `−8`;
    - `"… 2 more files"` when `totalFiles` is 7 with 5 files.
  - A system item renders `"System"` and the reason text.
  - A pending item renders `"Changes are still being recorded…"`.
  - An empty response shows `"No task updates yet."`.
  - `nextCursor` → clicking "Load older" calls `list` with `before` equal to the cursor.
  - Sidebar: extend `Sidebar.test.tsx` to assert a `Team feed` link to `/team-feed` exists right after Inbox.
- [ ] **Step 2:** Run each file with `--maxWorkers=2`. Expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Re-run each file and expect PASS. Run the ui typecheck and `pnpm check:token-gates`, and expect 0.
- [ ] **Step 5:** Commit `feat(ui): team feed page`.

### Task 6: Rollout

- [ ] **Step 1:** Re-run every new test file (one at a time), the server and ui typechecks, and the token gates.
- [ ] **Step 2:** Confirm no `running`/`queued` heartbeat runs. Run `pnpm paperclipai db:backup` in `~/paperclip`.
- [ ] **Step 3:** Run `git merge --ff-only feat/team-feed` in `~/paperclip`. Wait for `/api/health` 200 and for
  `/api/companies/<QUA>/team-feed` to return 200.
- [ ] **Step 4:** Take a Playwright screenshot of `/QUA/team-feed`. Expect the recent QUA status changes with their
  actors; the QUA-90 and QUA-94 items should show their captured files. Save it to
  `C:\Users\Admin\Pictures\Paperclip-baocao\2026-11-25\team-feed.png`.
- [ ] **Step 5:** Report to the owner.
