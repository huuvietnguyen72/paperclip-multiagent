# Team feed — design

Date: 2026-11-25. Status: approach A chosen by the owner ("Okay làm theo hướng A đi").

## Intent

The board wants one place to **read** what the agents have done. Every time a task changes status, a message
appears in a chat-like feed:
- who did it;
- which task;
- from which status to which status;
- what the agent said;
- which files the work changed (`path +a −b`).

The owner said the feed is read-only. Acting on what it shows is the job of the CEO and PM agents.

## Goals

1. A **Team feed** page, reachable from the sidebar, that lists task status changes newest first. The list covers the
   whole history, not only events after the feature ships.
2. Each message shows:
   - **actor**: the agent's name; "Board" for a user; "System" for recovery and automation;
   - **task**: its identifier and title, linking to the task;
   - **status change**: `from → to`, with status colouring;
   - **time**;
   - **the agent's note**: an excerpt of the latest comment by an agent on that task at or before the change;
   - **changed files**: per file `+a −b`, with a total, capped at 5 files plus "… N more files". The rows link to the
     task's Changes tab.
3. New messages appear without a reload, using the existing live updates.
4. "Load older" pages back through history.

## Non-goals

- Replying, giving orders or any input box. The page is read-only.
- Filters, search, unread counts and Telegram mirroring. These can be added later.
- Showing the full diff. The task's Changes tab already does that, and the feed links to it.

## Anti-goals

- **No LLM tokens.** Agents never write feed messages; the server derives them from data that already exists.
- **No new write paths, tables or migrations.** The feed is a read model over `activity_log`, `issues`,
  `issue_comments`, `agents` and `heartbeat_run_changes`.
- **No leaks.** A message never shows a task, comment or file that the viewer could not open on the task page.

## Approaches considered

| Approach | Trade-off | Decision |
|---|---|---|
| A. Read model over existing data (activity log + comments + run changes), computed per request | History from day one. No migration. Slightly more work per page read: one page is 30 messages. | **Picked by the owner** |
| B. New `team_feed_messages` table written by a worker on each status change | Fastest reads and frozen snapshots. But it needs a migration and a worker, and it only has messages from rollout onwards. | Rejected |
| C. Push messages into the experimental Agent Chat | Chat is built for 1:1 conversation with an input box. It is experimental and disabled on this instance. | Rejected |

## Design

### Source events

- Source rows are `activity_log` rows where:
  - `entity_type = 'issue'`;
  - `action = 'issue.updated'`;
  - `details->>'status'` is present.
- A creation (`issue.created`) is not a status change and is not shown.
- The new status is `details.status`. The previous status is the first present of:
  1. `details.changes.status.from`;
  2. `details._previous.status`;
  3. `details.previousStatus`;
  4. otherwise null, rendered as `→ to`.
- Rows where from equals to are skipped.
- Order is `created_at desc, id desc`. The cursor is `before=<createdAt>|<id>`, the page size defaults to 30, with a
  maximum of 100.

### Enrichment, per page in batched queries, not per row

- **Task:** `identifier` and `title` from `issues`.
- **Visibility:** rows whose issue the viewer cannot read (`issueReadSqlCondition(db, actor)`) are dropped. The page
  keeps reading until it has `limit` visible rows or there are no more rows.
- **Actor:**
  - `actorType` agent → the agent's name;
  - `user` → "Board";
  - `system` → "System".
  - `details.source` (e.g. `recovery.reconcile_configuration_incomplete`) is kept as a small reason tag.
- **Note:**
  - It is the latest `issue_comments` row on that issue with `author_agent_id` not null and `created_at <=` the event
    time plus 5 s. The grace allows for a comment posted together with the status change.
  - The body is reduced to plain text (Markdown stripped to text) and truncated to 280 chars.
  - It is null when there is no such comment, or when the comment is older than the previous status change on the same
    issue. That case would be a stale note.
- **Changed files** come from `heartbeat_run_changes` rows for the issue. Each row has `started_at`; its run's end
  time is `heartbeat_runs.finished_at`, falling back to `finalized_at`.
  - Agents usually change the status **during** their run, and the diff is only captured when the run ends. So a
    run is not required to have finished before the event.
  - **Attribution for a change to any status other than `done`:**
    - Each captured run is attributed to the issue's latest status event at or before the run's end time.
    - A run that ended before the issue's first status event goes to that first event.
    - A run still in progress goes to the issue's latest status event.
    - The message shows the runs attributed to it, which is "what this step changed".
  - **For a change to `done`:** every captured run of the issue that started at or before the event, which is the
    whole task.
  - **`pending`:** true when a run counted above (by its `started_at`) has a `pending` capture row. The UI then shows
    "Changes are still being recorded…" and re-fetches the first page every 15 s while any visible item is pending.
    Pending and live updates are what make a Done message fill in its files moments after the run ends.
  - Per path, sum additions and deletions across runs. Mark binary files.
  - Return the top 5 paths by `additions + deletions`, plus `totalFiles`, `additions` and `deletions` for all paths.
  - A file edited in several runs is counted in each run. This is acceptable as an overview, and the Changes tab has
    exact per-run diffs.

### API

- `GET /api/companies/:companyId/team-feed?before=&limit=` → `{ items: TeamFeedItem[], nextCursor: string | null }`.
- Board and agents of the company may read it; agents only see what they could read anyway. Company access is
  checked.
- It is a read, so it writes no activity log entry.

```ts
interface TeamFeedItem {
  id: string;              // activity_log id
  at: string;              // ISO time
  actor: { kind: "agent" | "board" | "system"; agentId: string | null; name: string };
  reason: string | null;   // details.source when not a plain comment/update
  issue: { id: string; identifier: string | null; title: string };
  fromStatus: string | null;
  toStatus: string;
  note: string | null;
  changes: { totalFiles: number; additions: number; deletions: number; pending: boolean;
             files: Array<{ path: string; additions: number; deletions: number; binary: boolean }> } | null; // null: no runs attributed
}
```

Shared types go in `packages/shared/src/team-feed.ts`.

### UI

- Route `/team-feed`, page `TeamFeed.tsx`.
- Sidebar item **"Team feed"** sits right after Inbox, on both the streamlined and the classic nav.
- Messages are chat-like cards, newest at the **top** (a feed, not a conversation):
  - an avatar or initial for the actor;
  - the name;
  - the task link `QUA-57 Màn hình…`;
  - a status pill `In progress → Done`;
  - the time;
  - the note in muted text;
  - a monospace file list with green `+a` and red `−b`, plus "… N more files · View changes", which opens the task
    with its Changes tab.
- Live updates: `useCompanyLiveEvent` invalidates the first page of the feed:
  - on `activity.logged` with `entityType === "issue"` and a `details.status`;
  - on a terminal `heartbeat.run.status`, so files appear once a run's capture is finalized.
- While any visible item has `changes.pending`, the feed also polls every 15 s.
- Loading, empty ("No task updates yet") and error states are shown, so failures are never silent.
- Strings are English (board UI convention), and styling is token-only (`pnpm check:token-gates`).

## Constraints

- Company scoping and issue read permissions are applied in the query, not only in the UI.
- Batched queries per page, with no N+1 per message. A page of 30 should answer in well under 1 s on the local
  embedded Postgres.
- Tests are vitest, one file at a time with `--maxWorkers=2`.
- Work happens in the worktree `~/paperclip-team-feed`, branch `feat/team-feed`. It merges to live only after a DB
  backup, with no runs in flight.

## Left to the builder

- The exact SQL shape: CTEs or several batched selects.
- The Markdown-to-text helper. Reuse an existing one if present.
- The visual details of the card within the design tokens.

## Calls made by Claude (owner may override)

- **Done** shows the whole task's changes. Other statuses show the runs attributed to that step, meaning runs that
  ended after the step's status change and before the next one.
- While a run is still recording, the message says so and fills in automatically.
- The note is the latest agent comment at the change, within a 5 s grace, ignoring comments older than the previous
  status change.
- The page is named "Team feed" and sits right after Inbox.
- Status changes by Board and System are shown too: for example, recovery marking a task blocked. That is part of
  "what happened".
