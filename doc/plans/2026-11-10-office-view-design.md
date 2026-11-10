# Office view ("Văn phòng"): design

Date: 2026-11-10
Status: draft for owner approval

## 1. Intent

The owner runs a Paperclip company, QuanLyDuAnPTIT. It has 10 AI agents (CEO, PM, BA, Tech Lead, Designer,
Backend, Frontend, DevOps, QA, Security) that work on a student project autonomously. The owner wants a tab that
answers three questions at a glance:

- Which agents are in which department?
- Who is working now, and on what?
- How much has the team done, and what did it cost?

The tab should feel alive: a 3D office the owner can rotate, with cartoon characters that move around according
to what they are doing. The reference for look and layout is the MIT project
[`khanh020905/my-office`](https://github.com/khanh020905/my-office), a three.js office for Claude Code sessions.
It is a reference for ideas and layout only. Copy no code, models or images from it.

The UI language for this owner is Vietnamese. The strings in this document are the intended Vietnamese labels.

## 2. Goals

1. Add a new company-scoped page "Văn phòng" at `/office`, and add a sidebar item for it.
   - In `Sidebar.production.tsx`, put the item in the "Company" section, next to Org.
   - In `Sidebar.tsx`, put it in the "Org" section in the streamlined shell, and in the "Organization" section in
     the classic shell, next to Costs.
   - The route must work in both classic and streamlined shells.
2. Use a three-column layout, modelled on my-office. Paperclip's own sidebar stays at the far left.
   - **Left rail ("Agent")**:
     - A count row: đang làm / chờ hoặc chặn / rảnh.
     - Agent cards in three groups, in this order. An agent belongs to the first group whose rule it meets:
       - **"Cần bạn xử lý"**: only when the owner actually has to act:
         - the agent's status is `error`;
         - the agent was paused by the budget or by an error rather than by hand;
         - a pending approval involves the agent;
         - one of its assigned issues is `blocked` and Paperclip's own blocker attention says the block needs a
           human (its `blockerAttention.state` is anything other than `"covered"`);
         - one of its assigned issues is `in_review` and the reviewer is the board or a user.
         An issue blocked by another agent's work (`blockerAttention.state: "covered"`, reason
         `active_dependency`) does not count. Today QUA-20 to QUA-23 are in that state, and putting them here would
         keep half the team flagged for nothing.
       - **"Đang làm"**: an agent is here if it has a live heartbeat run. The card shows the agent's name, the
         current issue identifier, a short status line (the current tool or status message), and a live elapsed
         timer (mm:ss, then h:mm:ss).
       - **"Rảnh"**: every other agent. An idle card shows "lần cuối …" from `lastHeartbeatAt`. If the agent has a
         covered blocked issue, the card adds "chờ QUA-xx", naming the blocking issue. If the agent was paused by
         hand, the card adds "tạm dừng" and the character is greyed.
     - Terminated agents and agents still pending approval are not shown anywhere on the page.
   - **Centre ("stage")**: a 3D office floor that the owner can rotate, pan and zoom. It has:
     - one character per agent;
     - a floating name label on each character;
     - a speech bubble for agents that are working or waiting;
     - a bottom toolbar with these controls: home view, department camera presets, zoom −/+ with %,
       fullscreen, and follow-selected-agent.
   - **Right panel**:
     - **"Thống kê"**, four tiles for the current calendar month:
       - việc đã xong
       - chi phí
       - thời gian chạy
       - đang làm (n / total)
     - **"Hoạt động"**, a live activity feed. Filter chips: Tất cả / Cần xử lý / Lượt chạy / Comment.
3. Split the floor into 4 department rooms plus 3 shared areas. The owner chose "by function":

   | Room | Agent roles |
   | --- | --- |
   | Ban Điều hành | `ceo`, `pm` |
   | Phân tích & Thiết kế | `cto`, `researcher`, `designer` |
   | Phòng Kỹ thuật | `engineer`, `devops` |
   | Kiểm định | `qa`, `security` |

   Shared areas:
   - **Phòng họp** (meeting room)
   - **Phòng server** (server room)
   - **Pantry** (break area)

   Any role not listed goes to Phòng Kỹ thuật. Department assignment is automatic from `agent.role`, so a newly
   hired agent appears in the right room without setup.
4. Characters move according to state. These mappings are the designer's proposal; the owner did not object.

   | Agent state | Where the character is | What it does |
   | --- | --- | --- |
   | Live run, ordinary work | at own desk | typing |
   | Live run, current tool is a shell or command tool, or the status says it is running tests or a build | Phòng server | — |
   | Agent just posted an issue comment (live event) | Phòng họp | stays about 20–30 s, then returns |
   | Idle | Pantry, or wandering near it | — |
   | Waiting or blocked ("Cần bạn xử lý") | stands at its desk | yellow "?" marker |
   | Paused or error | at its desk | red marker, muted colours |

   Movement is a walk along simple paths (corridors and doors), not teleporting.
5. Each character's colours come from the agent's existing `appearance.paletteId` (see
   `packages/shared/src/agent-appearance.ts`), so the 3D character matches the agent's avatar elsewhere in
   Paperclip.
6. Linking between views:
   - Clicking a rail card or a feed item selects that agent. The camera glides to it and its card is highlighted.
   - Clicking a character selects it the same way.
   - A selected agent's card shows a link to its current issue and to the agent page.
7. Everything updates live, without reload, from the existing company live-event socket.
8. **Model badge under each name.** Every character's floating label has two lines.
   - **Line 1** is the agent's name.
   - **Line 2** is a small logo plus the name of the model the agent is currently configured to use, for example
     "[Claude logo] Opus 5.5" or "[OpenAI logo] GPT-6.1 Sol". Today the company uses `claude-opus-5-5`,
     `claude-sonnet-5-5` and `gpt-6.1-sol`. Earlier it also used OpenCode Go models (Kimi, GLM, DeepSeek, Qwen).
   - **Where the model comes from:** `adapterConfig.model`. When it changes, the badge updates live through the
     `agent.updated` event. If no model is set, the badge shows only the adapter's logo and its display name.
   - **Logo:** reuse the brand marks Paperclip already ships in `ui/public/brands/`, through the mapping used by
     `ui/src/components/AdapterMark.tsx`. Pick by the model's family first:
     - `claude-*` → the Claude mark
     - `gpt-*`, `o*`, `codex*` → the OpenAI/Codex mark
     - `gemini*` → Gemini
     - `kimi*` → Kimi
     - `grok*` → Grok
     For any other model, fall back to the adapter's mark; for example, OpenCode with GLM, DeepSeek or Qwen shows
     the OpenCode logo. Add no new third-party logo files.
   - **Model name:** prefer the label from the adapter's model list, the same one the model dropdown in the agent
     config shows. Otherwise make it readable by stripping a provider prefix such as `opencode-go/` and
     prettifying the id: `claude-opus-5-5` → "Opus 5.5", `gpt-6.1-sol` → "GPT-6.1 Sol", `kimi-k3` → "Kimi K3". If
     neither works, show the raw id.
   - The same badge also appears on the agent's card in the left rail.
   - The labels are DOM overlays, for example `CSS2DRenderer` or projected absolutely positioned elements, not
     text inside the 3D scene. That keeps them sharp and lets them use the design tokens and `<img>` logos.
9. **Giao việc (assign new work)** reuses Paperclip's existing New issue dialog, via
   `useDialog().openNewIssue(defaults)` in `ui/src/context/DialogContext.tsx`. Build no new form.
   - A **"Giao việc"** button on the selected agent's card opens the dialog with
     `assigneeAgentId` set to that agent.
   - A **"Giao việc"** button in the stage's bottom toolbar opens the dialog with the CEO as assignee. The CEO is
     the agent with role `ceo`; if there is none, the dialog opens unassigned. The CEO is the default because the
     team works CEO → PM → agents.
   - When an issue is newly assigned to an agent (live event), that character shows a small paper or task icon
     above its head for a few seconds and walks back to its desk. This is cosmetic only.

## 3. Statistics: definitions

All figures are for the current calendar month (UTC month, which is the same convention as Costs). Each figure
is shown company-wide in the tiles and per agent on the rail card or the selected card.

| Figure | Definition | Source (existing API) |
| --- | --- | --- |
| Việc đã xong | Issues with status `done` and `completedAt` in this month. Per agent, count by assignee. | issues list for the company |
| Chi phí | The main number is **tokens** used this month (input + cached input + output), shown compactly, for example "100M token". Below it, the **money** spent, `spendCents`, shown as dollars. The owner chose tokens + money because almost every run is on a Claude or ChatGPT subscription, so money alone is about $0. Per agent: tokens and money. | `costsApi.summary` (company) and `costsApi.byAgent` (per agent) for the month. Must equal the Costs page's "By agent" list and its summary spend, not the "API spend" tile, which counts only API-billed usage. |
| Thời gian chạy | Sum of (`finishedAt` − `startedAt`) over heartbeat runs started this month, plus elapsed time of runs still live | `heartbeatsApi.list` for the company |
| Thời gian hiện tại | Now − `startedAt` of the agent's live run, ticking every second | `heartbeatsApi.liveRunsForCompany` |
| Đang làm | Number of agents with a live run / number of agents shown on the page | live runs plus the agents list |

Facts checked in the code, so the builder need not re-check them:
- **Month range:** the Costs page's "mtd" preset starts at the UTC month start (`useDateRange.computeRange`).
- **Live runs:** `liveRunsForCompany` returns `currentToolName` and `currentStatusMessage`.
- **Live socket:** without a per-run subscription, it sends only run activity pings. Do not rely on per-tool
  events. Use the live-runs query, refreshed on those pings.
- **Comments:** a new comment can be detected from `activity.logged` events.
- **`heartbeatsApi.list`:** has no date filter and returns at most 1000 rows (default 200). Page or filter on
  the client, or add the summary endpoint allowed above.
- **Issues:** `issuesApi` already has a paging "list all" helper.
- **Dependencies:** `three` is not yet a dependency of `ui/`.

The first version aggregates on the client, using existing endpoints and no server or database change. That is
fine at this company's size: tens of issues, hundreds of runs per month. If an endpoint paginates or caps
results so that the monthly sums would be wrong, the builder may add a small read-only company-scoped summary
endpoint. That endpoint must follow the repo's contract rules: shared types, the server route with company
access check, and the UI client.

## 4. Non-goals

The following are not in the first version:

- Anything from my-office that is about the host machine or Claude Code itself: RAM/CPU panel, dev-server
  cleanup, history vault, phone or PIN access, menubar, first-person "walk in", recap cards, trophies.
- Approving, commenting or reassigning existing issues from the office. The office only links to the existing
  issue, approval and agent pages. Creating new work is in scope (§2.9).
- Moving an agent to another room by hand. Assignment is by role only. The mapping is one constant, so changing
  it is a one-line edit.
- Multiple floor plans, an outdoor city, cars or street scenery. One floor is enough.
- Sound.
- Mobile layout beyond "does not break". On narrow screens the rail and panel may collapse under the stage.

## 5. Anti-goals

The build fails, even if it works, if any of these happen:

- **The rest of Paperclip gets slower or heavier.** three.js must be in a lazily loaded chunk that only the
  `/office` route pulls in. Rendering must pause when the tab is hidden or the page is left, and WebGL resources
  must be disposed on unmount.
- **Numbers disagree with Paperclip's own pages.** Chi phí, both tokens and money, must equal the Costs page's
  summary and its "By agent" list for the same month.
- **It copies my-office code, models or images.** Use ideas only.
- **Characters jitter, overlap through walls, or teleport** on every live event. State changes must be smoothed;
  for example, a character finishes its walk before starting a new one.
- **The page is blank or crashes when WebGL is unavailable.** Show the rail and the stats panel with a short
  "Không hiển thị được 3D trên trình duyệt này" message in the stage.

## 6. Constraints

- **Where to build:** the running instance is the WSL clone at `~/paperclip` (Ubuntu, Node 24, `pnpm dev`, UI
  served at `http://localhost:3100`). Build there so `pnpm dev` hot-reloads. Do not commit or push unless the
  owner asks. The clone tracks the upstream `paperclipai/paperclip`.
- **Repo rules:** follow `AGENTS.md`, `DESIGN.md` and `rules/*.mdc`.
  - **Token rule.** The rail, panel, toolbar, labels and bubbles are DOM in `ui/src/pages/**` and
    `ui/src/components/**`, so they must use design tokens only, and `pnpm check:token-gates` must pass.
  - **Scene colours.** The 3D scene's material colours are not UI chrome. Keep them in a scene module under
    `ui/src/lib/office/`, together with the palette mapping.
- **New dependency:** `three` (and `@types/three`) in `ui/`. A thin React wrapper such as
  `@react-three/fiber` is allowed if it keeps the code simpler. Pin exact versions.
- **Assets:** build everything procedurally from three.js primitives: low-poly desks, chairs, monitors, walls,
  glass partitions, plants, and characters made of boxes, capsules and spheres. Download no model files.
- **Visual style:** clean, isometric-leaning default camera like my-office's "Company" floor, warm floor
  materials, glass walls between rooms, a dark surround. The DOM panels follow Paperclip's theme (light and dark)
  through tokens.
- **Testing:**
  - Vitest for the pure logic: role → department, run or event → location and pose, the monthly stat
    aggregation, and rail grouping.
  - A manual browser check of the page against the live QuanLyDuAnPTIT company.
  - Per `AGENTS.md` §7, run the narrow checks first, then `pnpm -r typecheck` (or the low-memory variant),
    `pnpm test:run` and `pnpm build` before calling it done.

## 7. Decided by the owner

- It is a tab inside Paperclip, not a separate app.
- Use a rotatable 3D space with animated characters that move according to their work.
- Split departments by function (option A).
- The side panel shows: việc đã xong, chi phí, thời gian chạy, current-task elapsed time.
- Use the three-column layout modelled on my-office (left agent rail, centre 3D, right stats and activity).
- Chi phí shows tokens as the main number, with money underneath.
- Each character's label shows the logo and name of the agent's current model under the agent's name.
- New work can be assigned from the office, through the existing New issue dialog. Default it to the selected
  agent, or to the CEO when no agent is selected.
- The paused "test" agent was deleted on 2026-11-10. The company now has exactly the 10 team agents.

## 8. Decided by the designer (owner may override)

- Route `/office`, sidebar label "Văn phòng", in the Company section.
- The role → department table in §2.3, with unknown roles going to Phòng Kỹ thuật.
- The state → location and pose table in §2.4.
- The "Cần bạn xử lý" grouping rule in §2.2. It counts only things the owner must act on, using Paperclip's
  blocker-attention signal, so agents waiting on each other are not flagged.
- Paused-by-hand agents are shown greyed in "Rảnh". Terminated and pending agents are hidden.
- Sidebar placement is next to Org and Costs in each sidebar variant.
- Stats use the current calendar month, aggregated on the client.
- Characters reuse each agent's palette.
- Room assignment cannot be changed by hand in v1.

## 9. Left to the builder

- Scene graph structure, camera controls (for example `OrbitControls` with limited polar angle and zoom range),
  pathfinding approach (waypoints are enough), and animation technique.
- Exact room sizes and furniture placement, provided every agent of the current company has a desk, with
  headroom for growth to about 20 agents.
- How live events are debounced into state transitions.
- Component and file breakdown, and i18n wiring if the page uses the existing i18n setup.
