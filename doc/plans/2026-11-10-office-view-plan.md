# Office view ("Văn phòng") Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a company-scoped `/office` page to the Paperclip board UI. The page shows the company's agents as
animated characters in a rotatable 3D office split into departments. Around the office sit a live agent rail, a
stats panel and an activity feed, plus a way to assign new work.

**Architecture:** The page has three layers.
1. **Pure modules in `ui/src/lib/office/`.** They turn Paperclip data (agents, live runs, issues, costs, live
   events) into view models: department, group, location, pose, marker, model badge and stats. These carry all
   the rules and the unit tests.
2. **An imperative three.js scene in `ui/src/lib/office/scene/`.** It renders those view models and owns
   animation and pathing.
3. **React components in `ui/src/components/office/` and `ui/src/pages/Office.tsx`.** They fetch with React
   Query, subscribe to live events, render the DOM chrome (rail, stats, feed, toolbar, labels) with design
   tokens, and drive the scene.

The page is lazily loaded, so three.js only ships with `/office`.

**Tech Stack:** React 19, TypeScript, Vite, React Query, Tailwind and design tokens, three.js `0.170.0`
(`OrbitControls` from `three/examples/jsm`), and Vitest.

**Spec:** `doc/plans/2026-11-10-office-view-design.md` (approved 2026-11-10). Read it first. Section numbers like
§2.4 refer to it.

## Global Constraints

- Work in the WSL clone `~/paperclip`, which is what `pnpm dev` serves at `http://localhost:3100`. **Do not
  commit or push.** The owner has not asked for it.
- No server, database or `packages/shared` changes. Use only the existing endpoints listed per task.
- **New dependencies:** `three@0.170.0` and `@types/three@0.170.0` (dev) in `ui/`, pinned exactly.
- **Token gate:** files in `ui/src/components/**` and `ui/src/pages/**` use design tokens only: no hex, no raw
  px, no bracket values. `pnpm check:token-gates` must pass. Scene colours live only in
  `ui/src/lib/office/scene/`.
- **Copy no code, models or images from `khanh020905/my-office`.** All geometry is procedural three.js
  primitives.
- **UI copy is Vietnamese.** Every user-visible string lives in `ui/src/lib/office/strings.ts`, and nowhere
  else.
- **Hidden agents:** `status` is `"terminated"` or `"pending_approval"`.
- **Month:** the UTC calendar month, mirroring the Costs "mtd" preset in `useDateRange.computeRange`.
- **Shell:** the route must render in both classic and streamlined shells.
- **Test commands** (run from `~/paperclip/ui`): `pnpm exec vitest run <path>`. **Final gates** (run from
  `~/paperclip`): `pnpm -r typecheck` (or `node scripts/typecheck-low-memory.mjs`), `pnpm test:run`,
  `pnpm build`, `pnpm check:token-gates`.

## Review Focus

1. **Agent with a live run but no issue** (timer or wake run). It must show as "Đang làm" with the status line
   and timer, and no issue link; it must not crash. Test it in Task 2.
2. **Model id that matches no known family and is not in the adapter list** (for example
   `opencode-go/qwen3.8-max`, or an empty string). The label must still be readable, the logo must be the
   adapter's mark, and an empty model shows the adapter's name. Test it in Task 1.
3. **Live run that started in a previous month and is still running.** Its elapsed time must count toward
   "Thời gian chạy" only from the month start, never as a negative or doubled value. Test it in Task 3.
4. **WebGL unavailable**, or the scene constructor throws. The rail, stats and feed must still render, and the
   stage shows `strings.noWebgl`. Test it in Task 5.
5. **Rapid live-event bursts** (several status changes within a second for one agent). The character must
   finish its current walk before taking the newest target, with no teleporting and no stacking. Test it in
   Task 6 with the `OfficeCharacter` queue.

---

### Task 1: Departments, strings, and model badge

**Files:**
- Create: `ui/src/lib/office/strings.ts`, `ui/src/lib/office/departments.ts`, `ui/src/lib/office/model-badge.ts`
- Test: `ui/src/lib/office/departments.test.ts`, `ui/src/lib/office/model-badge.test.ts`

**Interfaces:**
- Produces:
  - `type DepartmentId = "executive" | "analysis" | "engineering" | "quality"`
  - `type SharedAreaId = "meeting" | "server" | "pantry"`
  - `DEPARTMENTS: ReadonlyArray<{ id: DepartmentId; roles: readonly string[] }>`, in the spec §2.3 order
  - `departmentForRole(role: string | null | undefined): DepartmentId`
  - `strings`: a frozen object of every Vietnamese label. It includes `departments: Record<DepartmentId, string>`,
    `areas: Record<SharedAreaId, string>`, the group titles, the stat titles, `assignWork: "Giao việc"` and
    `noWebgl`.
  - `interface ModelBadge { label: string; markType: string }`. `markType` is a key that `AdapterMark`
    understands.
  - `modelBadgeFor(adapterType: string, model: string | null | undefined, adapterLabels?: ReadonlyMap<string, string>): ModelBadge`

- [ ] **Step 1: Write failing tests**

```ts
// departments.test.ts
expect(departmentForRole("ceo")).toBe("executive");
expect(departmentForRole("pm")).toBe("executive");
expect(departmentForRole("cto")).toBe("analysis");
expect(departmentForRole("researcher")).toBe("analysis");
expect(departmentForRole("designer")).toBe("analysis");
expect(departmentForRole("engineer")).toBe("engineering");
expect(departmentForRole("devops")).toBe("engineering");
expect(departmentForRole("qa")).toBe("quality");
expect(departmentForRole("security")).toBe("quality");
expect(departmentForRole("general")).toBe("engineering");
expect(departmentForRole(undefined)).toBe("engineering");
expect(strings.departments).toEqual({ executive: "Ban Điều hành", analysis: "Phân tích & Thiết kế", engineering: "Phòng Kỹ thuật", quality: "Kiểm định" });
expect(strings.areas).toEqual({ meeting: "Phòng họp", server: "Phòng server", pantry: "Pantry" });

// model-badge.test.ts
expect(modelBadgeFor("claude_local", "claude-opus-5-5")).toEqual({ label: "Opus 5.5", markType: "claude_local" });
expect(modelBadgeFor("claude_local", "claude-sonnet-5-5")).toEqual({ label: "Sonnet 5.5", markType: "claude_local" });
expect(modelBadgeFor("codex_local", "gpt-6.1-sol")).toEqual({ label: "GPT-6.1 Sol", markType: "codex_local" });
expect(modelBadgeFor("opencode_local", "opencode-go/kimi-k3")).toEqual({ label: "Kimi K3", markType: "kimi_local" });
expect(modelBadgeFor("opencode_local", "opencode-go/glm-5.3")).toEqual({ label: "GLM-5.3", markType: "opencode_local" });
expect(modelBadgeFor("opencode_local", "opencode-go/qwen3.8-max")).toEqual({ label: "Qwen3.8 Max", markType: "opencode_local" });
expect(modelBadgeFor("claude_local", "gemini-3-pro").markType).toBe("gemini_local");
expect(modelBadgeFor("claude_local", "claude-opus-5-5", new Map([["claude-opus-5-5", "Claude Opus 5.5"]])).label).toBe("Claude Opus 5.5");
expect(modelBadgeFor("codex_local", "")).toEqual({ label: "Codex", markType: "codex_local" }); // adapter display name
expect(modelBadgeFor("claude_local", null).label).toBe("Claude Code"); // adapter display name
```

For the last two cases, take the adapter display name from `getAdapterDisplay(type).label` in
`@/adapters/adapter-display-registry`. Adjust the two expected strings to whatever that registry returns, and
keep the rule.

- [ ] **Step 2: Run `pnpm exec vitest run src/lib/office` and confirm the tests fail with "not defined".**

- [ ] **Step 3: Implement the three modules.**
  - **Family → mark:**
    - `claude-` → `claude_local`
    - `gpt-`, `o<digit>`, `codex` → `codex_local`
    - `gemini` → `gemini_local`
    - `kimi` → `kimi_local`
    - `grok` → `grok_local`
    - otherwise → `adapterType`
  - **Label precedence:**
    1. the adapter label from the map, when present;
    2. otherwise the prettified id;
    3. otherwise the raw id.
  - **Prettify:** strip everything up to the last `/`. Then:
    - `^claude-([a-z]+)-(\d+)-(\d+)` → `Cap(name) a.b`;
    - otherwise split on `-`. The tokens `gpt` and `glm` are upper-cased and joined to the following numeric
      token with `-`. Other tokens are capitalised (`k3` → `K3`). Join with spaces.

- [ ] **Step 4: Rerun the tests and confirm they PASS.**

---

### Task 2: Agent state derivation (group, location, pose, marker)

**Files:**
- Create: `ui/src/lib/office/agent-state.ts`
- Test: `ui/src/lib/office/agent-state.test.ts`

**Interfaces:**
- Consumes: `departmentForRole`, `modelBadgeFor`, `ModelBadge`, `DepartmentId`, `SharedAreaId` (Task 1). Types
  `Agent`, `Issue`, `Approval` from `@paperclipai/shared`, and `LiveRunForIssue` from `@/api/heartbeats`.
- Produces:

```ts
export type OfficeGroup = "attention" | "working" | "idle";
export type OfficeSpot = "desk" | SharedAreaId;
export type OfficePose = "typing" | "standing" | "idle";
export type OfficeMarker = "attention" | "error" | "paused" | null;
export interface OfficeAgentView {
  id: string; name: string; role: string; department: DepartmentId; paletteId: string; muted: boolean;
  group: OfficeGroup; spot: OfficeSpot; pose: OfficePose; marker: OfficeMarker;
  currentIssue: { id: string; identifier: string | null } | null;
  statusLine: string | null; runStartedAt: string | null; waitingOn: string | null;
  lastHeartbeatAt: string | null; badge: ModelBadge; assignedFlashUntil: number | null;
}
export interface OfficeInputs {
  agents: Agent[]; liveRuns: LiveRunForIssue[]; issues: Issue[]; pendingApprovals: Approval[];
  recentCommentAt: ReadonlyMap<string, number>;   // agentId -> epoch ms of last comment
  recentAssignedAt: ReadonlyMap<string, number>;  // agentId -> epoch ms of last new assignment
  adapterLabels: ReadonlyMap<string, ReadonlyMap<string, string>>; // adapterType -> modelId -> label
  now: number;
}
export const MEETING_LINGER_MS = 25_000;
export const ASSIGNED_FLASH_MS = 5_000;
export function deriveOfficeAgents(input: OfficeInputs): OfficeAgentView[]; // hidden agents removed, sorted by department then name
```

**Rules (spec §2.2 and §2.4).** Apply them in this order:

1. **Hidden:** `status` is `terminated` or `pending_approval`.
2. **`attention`** applies if any of these holds:
   - `status === "error"`;
   - `status === "paused"` with `pauseReason` in `budget` or `system`;
   - a pending approval has `requestedByAgentId === agent.id` or `payload.agentId === agent.id`;
   - an assigned, non-done issue has `status === "blocked"` and `blockerAttention.state` is in `stalled` or
     `needs_attention`;
   - an assigned issue has `status === "in_review"` and `reviewAttention.paths` contains `kind` `approval` or
     `interaction`.

   The marker is `"error"` for error, otherwise `"attention"`.
3. **`working`:** the agent has a live run (`liveRuns` with matching `agentId` and status
   `running`/`queued`). Fill `currentIssue` from the run's `issueId`, matched against `issues`, and fall back
   to the id with a null identifier. `statusLine` is `currentStatusMessage ?? currentToolName`.
   `runStartedAt` is the run's `startedAt`.
4. **`idle`:** everything else.
   - A manual pause sets `muted: true` and `marker: "paused"`.
   - `waitingOn` is the `sampleBlockerIdentifier` of an assigned blocked issue whose
     `blockerAttention.state === "covered"`.

**Spot and pose:**

| Condition | Spot | Pose |
| --- | --- | --- |
| Agent commented within `MEETING_LINGER_MS` | `"meeting"` | `"standing"` (overrides all below) |
| Working, and `currentToolName` matches `/^(bash\|shell\|exec\|command\|run_shell_command\|local_shell)/i` or `statusLine` matches `/\b(test\|build\|lint\|typecheck\|pnpm\|npm\|docker)\b/i` | `"server"` | `"standing"` |
| Working, otherwise | `"desk"` | `"typing"` |
| Attention | `"desk"` | `"standing"` |
| Idle and muted | `"desk"` | `"idle"` |
| Idle, otherwise | `"pantry"` | `"idle"` |

`assignedFlashUntil` is `recentAssignedAt + ASSIGNED_FLASH_MS` if that is in the future, otherwise `null`. A
flash forces `spot: "desk"`.

- [ ] **Step 1: Write failing tests.** Build fixtures as minimal objects cast to the shared types. Cover:
  - `hides terminated and pending_approval agents`
  - `error agent → group attention, marker error`
  - `budget-paused → attention; manual-paused → idle, muted, marker paused, spot desk`
  - `blocked issue with blockerAttention covered → idle with waitingOn "QUA-25", not attention`
  - `blocked issue with blockerAttention needs_attention → attention`
  - `in_review with reviewAttention path kind approval → attention`
  - `live run with currentToolName "Bash" → working, spot server, pose standing`
  - `live run with statusMessage "Editing src/app.ts" → working, spot desk, pose typing, statusLine set, runStartedAt set`
  - `live run with no issueId → working, currentIssue null` (Review Focus 1)
  - `comment 10s ago → spot meeting; 30s ago → not meeting`
  - `assigned 2s ago → assignedFlashUntil set and spot desk`
  - `CEO agent with claude-opus-5-5 → badge "Opus 5.5"`
  - `sorted by DEPARTMENTS order then name`
- [ ] **Step 2: Run `pnpm exec vitest run src/lib/office/agent-state.test.ts` and confirm it FAILS.**
- [ ] **Step 3: Implement `deriveOfficeAgents`.**
- [ ] **Step 4: Rerun and confirm it PASSES.**

---

### Task 3: Stats aggregation and formatting

**Files:**
- Create: `ui/src/lib/office/stats.ts`
- Test: `ui/src/lib/office/stats.test.ts`

**Interfaces:**
- Consumes: `OfficeAgentView` (Task 2). Types `Issue`, `HeartbeatRun`, `CostSummary`, `CostByAgent` from
  `@paperclipai/shared`.
- Produces:

```ts
export interface StatBlock { doneCount: number; tokens: number; spendCents: number; runtimeMs: number }
export interface OfficeStats { company: StatBlock & { workingCount: number; shownCount: number }; byAgent: Map<string, StatBlock> }
export function utcMonthStart(now: Date): Date;
export function aggregateOfficeStats(a: {
  agents: OfficeAgentView[]; issues: Issue[]; runs: HeartbeatRun[];
  costSummary: CostSummary | null; costByAgent: CostByAgent[]; now: Date;
}): OfficeStats;
export function formatTokens(n: number): string;   // 950 → "950", 12_300 → "12.3K", 100_400_000 → "100M"
export function formatSpend(cents: number): string; // 5.77 → "$0.06", 0 → "$0.00", 123456 → "$1,234.56"
export function formatDuration(ms: number): string; // 51_600_000 → "14h 20m", 300_000 → "5m", 0 → "0m"
export function formatElapsed(ms: number): string;  // 760_000 → "12:40", 3_723_000 → "1:02:03"
```

**Definitions (spec §3):**
- **`doneCount`:** issues with `status === "done"` and `completedAt` at or after the month start. Per agent, key
  by `assigneeAgentId`.
- **`tokens`:** the sum of `inputTokens + cachedInputTokens + outputTokens` over `costByAgent`. Company tokens
  include rows with `agentId === null`.
- **`spendCents`:** company spend is `costSummary.spendCents`; per agent, it is the matching `costByAgent` row.
- **`runtimeMs`:** for each run, `max(0, (finishedAt ?? now) − max(startedAt, monthStart))`. Skip runs without
  `startedAt` or whose end is before the month start.
- **`workingCount`:** agents whose `group === "working"`.
- **`shownCount`:** `agents.length`.

- [ ] **Step 1: Write failing tests.** Cover:
  - each format example above;
  - `utcMonthStart(new Date("2026-11-10T08:00:00Z"))` → `2026-11-01T00:00:00.000Z`;
  - an issue done on Oct 31 is excluded, and one done on Nov 2 is included;
  - **Review Focus 3:** a run started `2026-10-31T23:00Z` and still live at `2026-11-01T01:00Z` adds exactly
    3_600_000 ms;
  - a finished run of 30 min adds 1_800_000 ms;
  - company tokens include a null-agent row;
  - company spend equals `costSummary.spendCents` even when `byAgent` sums differ.
- [ ] **Step 2: Run and confirm it FAILS.** Then **Step 3:** implement. Then **Step 4:** run and confirm it
  PASSES.

---

### Task 4: Activity feed model and the data hook

**Files:**
- Create: `ui/src/lib/office/activity-feed.ts`, `ui/src/pages/office/useOfficeData.ts`
- Test: `ui/src/lib/office/activity-feed.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3, plus:
  - `LiveEvent` from `@paperclipai/shared` and `useCompanyLiveEvent` from `@/context/LiveUpdatesProvider`;
  - `agentsApi.list`, `agentsApi.adapterModels(companyId, type)`;
  - `heartbeatsApi.liveRunsForCompany(companyId)`, `heartbeatsApi.list(companyId, undefined, 1000)`;
  - `issuesApi.listAll(companyId, {})`;
  - `approvalsApi.list(companyId, "pending")`;
  - `costsApi.summary(companyId, from)`, `costsApi.byAgent(companyId, from)`, where
    `from = utcMonthStart(now).toISOString()`.
- Produces:

```ts
export type FeedFilter = "all" | "attention" | "runs" | "comments";
export interface FeedItem { id: string; at: string; agentId: string | null; issueId: string | null;
  kind: "run" | "comment" | "issue"; tone: "ok" | "warn" | "error"; text: string }
export function feedItemFromLiveEvent(e: LiveEvent, ctx: { agentName(id: string): string | null; issueIdentifier(id: string): string | null }): FeedItem | null;
export function pushFeedItem(list: readonly FeedItem[], item: FeedItem, max?: number /* 50 */): FeedItem[]; // newest first, dedupe by id
export function filterFeed(list: readonly FeedItem[], f: FeedFilter): FeedItem[]; // attention = tone !== "ok"

// useOfficeData.ts
export interface OfficeData { agents: OfficeAgentView[]; stats: OfficeStats; feed: FeedItem[];
  isLoading: boolean; error: Error | null; now: number }
export function useOfficeData(companyId: string): OfficeData;
```

**Event mapping (copy comes from `strings`):**

| Live event | Feed item |
| --- | --- |
| `heartbeat.run.status`, payload status `running` | kind `run`, tone `ok`, "Bắt đầu lượt chạy" |
| …status `succeeded` | kind `run`, tone `ok`, "Hoàn thành lượt chạy" |
| …status `failed` or `timed_out` | kind `run`, tone `error`, "Lượt chạy lỗi" plus `payload.error` when present |
| …status `cancelled` | kind `run`, tone `warn`, "Lượt chạy bị huỷ" |
| `activity.logged` with action `issue.comment_added` and `actorType === "agent"` | kind `comment`, tone `ok`, "Comment trong {identifier}" |
| `activity.logged` with action `issue.updated` and `details.status` in `blocked`/`in_review` | kind `issue`, tone `warn`, "{identifier} → {status}" |
| `activity.logged` with action `issue.updated` and `details.status === "done"` | kind `issue`, tone `ok`, "Hoàn thành {identifier}" |
| anything else | `null` |

The item id is `` `${e.type}:${e.id}` ``.

**Hook behaviour:**
- **Refresh rates:** React Query, with a 15 s `refetchInterval` on live runs and a 60 s interval on everything
  else. On a live event:
  - `heartbeat.run.*` or `agent.*` invalidates the live runs and agents queries;
  - `activity.logged` invalidates issues, and costs when `heartbeat.run.status` is final.
- **Recent activity maps:** keep `recentCommentAt` and `recentAssignedAt` in refs, updated from
  `activity.logged`:
  - a comment by an agent sets that agent's entry;
  - an `issue.created` or `issue.updated` whose `details.assigneeAgentId` is set records that agent.
- **Clock:** a 1 s ticker drives `now`.
- **Adapter labels:** fetch `adapterModels` once per distinct adapter type with `staleTime: Infinity`. Ignore
  failures (empty map).

- [ ] **Step 1: Write failing tests for `feedItemFromLiveEvent`, `pushFeedItem` and `filterFeed`.** Cover:
  - each mapping row;
  - dedupe;
  - the cap at 50;
  - newest first;
  - an `attention` filter that drops `ok` items.
- [ ] **Step 2: Run and confirm it FAILS.** Then **Step 3:** implement `activity-feed.ts` and `useOfficeData`.
  Then **Step 4:** run and confirm it PASSES, and run `pnpm --filter @paperclipai/ui typecheck` (or
  `cd ui && pnpm exec tsc --noEmit`) clean.

---

### Task 5: Route, sidebar entry, page shell with rail, stats and feed (no 3D yet)

**Files:**
- Create:
  - `ui/src/pages/Office.tsx`
  - `ui/src/components/office/OfficeRail.tsx`
  - `ui/src/components/office/OfficeStatsPanel.tsx`
  - `ui/src/components/office/ModelBadge.tsx`
  - `ui/src/components/office/OfficeStageFallback.tsx`
- Modify:
  - `ui/src/App.tsx`: add `const Office = lazy(() => import("./pages/Office"))` next to the other lazy pages,
    and `<Route path="office" element={<ProductionSurface><Office /></ProductionSurface>} />` inside
    `boardRoutes`, unconditionally, so it exists in both shells.
  - `ui/src/components/Sidebar.tsx`, next to the `/org` item near line 300, and
    `ui/src/components/Sidebar.production.tsx`, next to `/org` near line 228: add
    `<SidebarNavItem to="/office" label="Văn phòng" icon={Building2} />`, importing `Building2` from
    `lucide-react`.
- Test: `ui/src/pages/Office.test.tsx`

**Interfaces:**
- Consumes: `useOfficeData` (Task 4), `strings`, the formatters, and `AdapterMark` from
  `@/components/AdapterMark`.
- Produces:
  - `ModelBadge({ badge, size }: { badge: ModelBadge; size?: "sm" | "xs" })`
  - `OfficeRail({ agents, stats, now, selectedId, onSelect, onAssign })`
  - `OfficeStatsPanel({ stats, feed, filter, onFilter, onSelectAgent })`
  - Page state: `selectedId: string | null`, `feedFilter: FeedFilter`
  - The stage slot renders `OfficeStageFallback` for now. Task 6 swaps in the real stage.
  - `onAssign(agentId | null)` calls `useDialog().openNewIssue({ assigneeAgentId })`. For `null` it uses the
    `ceo`-role agent's id if there is one, and otherwise opens with no defaults (spec §2.9).

**Layout:**
- **Wide screens:** a flex row, using token spacing/colours only. The rail is a fixed narrow column on the
  left, the stage is `flex-1`, and the panel is a fixed column on the right.
- **Below `lg`:** stack the stage first, then the rail, then the panel.
- **Rail:**
  - the count row;
  - groups in the order attention → working → idle, with the group titles from `strings`;
  - each card shows the name, `ModelBadge`, a status or "lần cuối …" line, and `formatElapsed(now − runStartedAt)` for working agents;
  - the selected card is highlighted and shows "Giao việc", plus links to `/issues/{identifier}` and
    `/agents/{urlKey or id}`.
- **Panel:**
  - four stat tiles:
    - Việc đã xong
    - Chi phí: `formatTokens(tokens)` + " token" as the main number, `formatSpend(spendCents)` beneath
    - Thời gian chạy
    - Đang làm `n / total`
  - the selected agent's own StatBlock, shown when an agent is selected;
  - the filter chips and the feed list. Clicking a feed item selects its agent.

- [ ] **Step 1: Write failing tests** (React Testing Library, with `useOfficeData` mocked via `vi.mock`). Cover:
  - `renders the three rail groups in order with counts`
  - `working card shows the elapsed timer "12:40"`
  - `stat tiles show "100M token" and "$0.06"`
  - `clicking Giao việc on a selected agent calls openNewIssue with its assigneeAgentId`
  - `toolbar-level assign with no selection uses the ceo agent`
  - `ModelBadge renders the label text`
- [ ] **Step 2: Run `pnpm exec vitest run src/pages/Office.test.tsx` and confirm it FAILS.** Then **Step 3:**
  implement. Then **Step 4:** run and confirm it PASSES, and `pnpm check:token-gates` passes.
- [ ] **Step 5: Manual check.** Open `http://localhost:3100/<company-prefix>/office` (`pnpm dev` is running in
  WSL). Confirm the sidebar item, the 10 agents, plausible stats, and the feed updating when an agent runs.

---

### Task 6: 3D scene, office layout, characters and pathing

**Files:**
- Modify: `ui/package.json` (add the deps, then `pnpm install`)
- Create:
  - `ui/src/lib/office/scene/layout.ts`: pure floor plan and waypoint graph
  - `ui/src/lib/office/scene/palette.ts`: scene colours, and `characterColors(paletteId, muted)` built on
    `CAP_V1_COLORS` from `@paperclipai/shared/cliplab/palette-tokens`
  - `ui/src/lib/office/scene/build-office.ts`: floor, walls, glass partitions, desks, chairs, monitors, plants,
    meeting table, server racks, pantry counter
  - `ui/src/lib/office/scene/character.ts`
  - `ui/src/lib/office/scene/office-scene.ts`
  - `ui/src/components/office/OfficeStage.tsx`
- Test: `ui/src/lib/office/scene/layout.test.ts`, `ui/src/lib/office/scene/character.test.ts`

**Interfaces:**

```ts
// layout.ts (units: metres, x/z plane)
export interface Vec2 { x: number; z: number }
export interface RoomRect { id: DepartmentId | SharedAreaId; x: number; z: number; w: number; d: number; door: Vec2 }
export const ROOMS: readonly RoomRect[];                       // 4 departments + 3 shared areas, non-overlapping
export const DESKS_PER_DEPARTMENT = 6;                        // ≥ 20 desks total (spec §9 headroom)
export function deskSlot(dept: DepartmentId, index: number): { seat: Vec2; facing: number }; // index wraps past capacity
export function areaSpot(area: SharedAreaId, index: number): Vec2;                           // distinct spots per index
export function findPath(from: Vec2, to: Vec2): Vec2[];       // via door + corridor waypoints; first = nearest waypoint to from, last = to

// character.ts
export class OfficeCharacter {
  constructor(id: string, colors: { a: string; b: string });
  readonly object: THREE.Group;
  setPose(p: OfficePose): void;
  goTo(path: Vec2[]): void;   // if walking, queue as the single pending path (latest wins); never teleports
  update(dtSec: number): void; // walk speed 1.4 m/s, idle bob, typing arm motion
  readonly isWalking: boolean; readonly pendingPath: Vec2[] | null; position(): Vec2;
  dispose(): void;
}

// office-scene.ts
export class OfficeScene {
  constructor(host: HTMLElement);                          // throws if WebGL is unavailable
  setAgents(views: OfficeAgentView[]): void;               // add/remove characters, route each to its spot
  setSelected(id: string | null): void;                    // outline/ring under the selected character
  focusAgent(id: string): void; focusArea(id: DepartmentId | SharedAreaId | "home"): void;
  setFollow(id: string | null): void; zoomBy(factor: number): void; zoomPercent(): number;
  onPick(cb: (agentId: string | null) => void): void;
  labelPositions(): Map<string, { x: number; y: number; visible: boolean }>; // CSS px within host
  dispose(): void;                                         // cancels RAF, disposes geometries/materials/renderer
}
```

**Scene rules:**
- **Renderer:** `WebGLRenderer({ antialias: true })` with `setPixelRatio(min(devicePixelRatio, 2))`, shadows on,
  and size tracked with a `ResizeObserver` on the host.
- **Camera:** a `PerspectiveCamera` with a default isometric-leaning view looking at the floor centre.
  `OrbitControls` with damping, `minPolarAngle 0.3`, `maxPolarAngle 1.25`, a zoom (distance) range of 8–45 m,
  and pan enabled.
- **Look:** warm wood floor per department, with a slightly different tint per department. Glass partitions are
  transparent `MeshPhysicalMaterial`. The surround is dark.
- **Characters:** capsule body (shirt colour `a`), sphere head (skin tone), hair cap (colour `b`), box arms and
  legs. A muted agent uses `CAP_V1_COLORS["muted-dream"]`.
- **Spots:**
  - `"desk"` → that agent's `deskSlot(department, index)`, where `index` is the agent's position among its
    department's agents in `views` order;
  - a shared area → `areaSpot(area, index among agents in that area)`.
- **Animation:** one `requestAnimationFrame` loop. Stop it while `document.hidden`, and resume on
  `visibilitychange`.
- **Picking:** raycast on pointer up, only when the pointer moved less than 5 px since pointer down, so drags
  never select.

**OfficeStage:**
- **Mount:** creates `OfficeScene` in a `useEffect` and calls `setAgents` whenever the views change.
- **Fallback:** catches a constructor error and renders `OfficeStageFallback` (Review Focus 4).
- **Labels:** renders a DOM label per agent, positioned from `labelPositions()` on every animation frame (a RAF
  in the component reading from the scene). Each label has a name line, a `ModelBadge` line, and a bubble:
  - working: `statusLine · formatElapsed`;
  - attention: "?" with the issue identifier;
  - waiting: "chờ {waitingOn}";
  - assigned flash: a task icon.

  Labels use tokens only. Positioning uses inline `style={{ transform: translate(...) }}`, which the token gate
  allows for computed values; confirm with `pnpm check:token-gates`.
- **Loading:** `Office.tsx` loads `OfficeStage` via `lazy(() => import("@/components/office/OfficeStage"))`, so
  three.js lands in its own chunk.

- [ ] **Step 1: Write failing tests.** Cover:
  - `ROOMS do not overlap`
  - `there are ≥ 20 desk slots across the four departments, all inside their room`
  - `deskSlot indices are distinct within capacity`
  - `findPath from a desk in executive to the pantry spot ends at the target and every segment passes through
    doors/corridor waypoints (no point inside a foreign room except its door)`
  - `areaSpot returns distinct points for indices 0..5`
  - Character, with no WebGL needed: `goTo` while walking stores `pendingPath` and keeps the current target;
    `update` advances at 1.4 m/s; after arrival it takes the pending path; three rapid `goTo` calls leave
    exactly one pending path, the last (Review Focus 5).
- [ ] **Step 2: Run `pnpm exec vitest run src/lib/office/scene` and confirm it FAILS.** Then **Step 3:**
  implement. Then **Step 4:** run and confirm it PASSES.
- [ ] **Step 5: Manual check in the browser:**
  - the office renders, rotates and zooms;
  - the 10 characters sit in the correct rooms;
  - a working agent types at its desk or walks to the server room;
  - idle agents are in the pantry;
  - labels follow characters and show the model badge.
  - In devtools Network, confirm no `three` chunk loads on `/dashboard`.

---

### Task 7: Interactions: selection, camera, toolbar, follow, assign flash

**Files:**
- Create: `ui/src/components/office/OfficeToolbar.tsx`
- Modify: `ui/src/components/office/OfficeStage.tsx`, `ui/src/pages/Office.tsx`
- Test: extend `ui/src/pages/Office.test.tsx` (mock `OfficeStage` with a stub exposing the props it was called
  with)

**Interfaces:**
- Consumes: `OfficeScene` methods (Task 6) and page state (Task 5).
- Produces: `OfficeStage` props
  `{ agents: OfficeAgentView[]; now: number; selectedId: string | null; onSelect(id: string | null): void; onAssign(id: string | null): void }`.
  `OfficeToolbar` props
  `{ onHome(): void; onArea(id: DepartmentId | SharedAreaId): void; zoomPercent: number; onZoom(f: number): void; onFullscreen(): void; following: boolean; onFollowToggle(): void; onAssign(): void }`.

**Behaviour:**
- **Selecting:**
  - a rail card or feed item click → `selectedId` → the stage calls `setSelected` and `focusAgent` (camera
    glides over about 600 ms);
  - picking a character → `onSelect(id)`;
  - picking empty floor → `onSelect(null)`.
- **Toolbar:**
  - Home;
  - a department/area menu (the 7 rooms, labelled from `strings`);
  - − / % / +;
  - fullscreen on the stage container (`requestFullscreen`);
  - follow, enabled only when an agent is selected;
  - "Giao việc", which calls `onAssign(null)` and therefore defaults to the CEO.
- **Assign flash:** while `assignedFlashUntil > now`, the label shows the task icon (the walk to the desk comes
  from Task 2's spot rule).

- [ ] **Step 1: Write failing tests.** Cover:
  - `clicking a rail card passes selectedId to OfficeStage`
  - `OfficeStage onSelect(null) clears the rail highlight`
  - `toolbar Giao việc opens New issue for the ceo agent`
  - `follow button disabled with no selection`
- [ ] **Step 2: Run and confirm it FAILS.** Then **Step 3:** implement. Then **Step 4:** run and confirm it
  PASSES.
- [ ] **Step 5: Manual check:**
  - clicking characters and rail cards keeps both views in sync;
  - the camera glides;
  - follow tracks a walking agent;
  - "Giao việc" opens the real New issue dialog pre-filled;
  - creating an issue for an idle agent makes it flash and walk to its desk.

---

### Task 8: Full verification

- [ ] Run from `~/paperclip`, and confirm each passes or report exactly what failed:
  - `node scripts/typecheck-low-memory.mjs` (or `pnpm -r typecheck`)
  - `pnpm test:run`
  - `pnpm build`
  - `pnpm check:token-gates`
- [ ] Check `pnpm build` output: three.js appears only in the Office chunk, not in the main entry chunk.
- [ ] **Final browser pass on QuanLyDuAnPTIT:**
  - the light and dark themes both look right;
  - the narrow-window stacking works;
  - leaving the page stops the GPU loop (no console errors, and the RAF stops);
  - the stat tiles equal the Costs page's summary spend and "By agent" tokens for the month.
- [ ] Do not commit. Report to the owner what changed and how to view it.
