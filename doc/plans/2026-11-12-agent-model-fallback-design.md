# Agent model fallback ("Kết nối model"): design

Date: 2026-11-12
Status: draft for owner approval

## 1. Intent

The owner runs the Paperclip company QuanLyDuAnPTIT (prefix QUA). It has 10 agents that build a student project on
their own. Almost every agent regularly hits its provider's usage limit. When that happens the work stops: Paperclip
records the run as failed with `errorCode: "provider_quota"`, reads the reset time from the error, and waits until
then to retry the same agent on the same provider. Today the owner works around this by hand. They change the agent's
harness and model, for example from Claude Code to OpenCode Go, so that work continues.

This feature automates that manual switch. Each agent gets an ordered **chain of connections** (harness + account +
model). When the connection in use runs out, the agent moves to the next usable connection and the interrupted task
is retried immediately. The page must always show clearly which connection the agent is using right now.

The owner today has these accounts:

- **Two different Claude accounts.** They are the two Anthropic AI connections in Paperclip, "My Claude subscription"
  and "Anthropic"; see §2.
- **One OpenCode Go subscription.**
- **Codex (OpenAI)**, which is also connected in Paperclip. Frontend Engineer uses it.

The owner may add more accounts later.

The reference for the look of this feature is the open-source project
[`kaitranntt/ccs`](https://github.com/kaitranntt/ccs) (CCS, "Claude Code Switch"). Three of its screens are the
reference: Live Account Monitor (a hub diagram plus a live timeline), CCS Bar (5-hour and weekly quota bars) and the
CLIProxy provider list. Use it for ideas only. Copy no code or images.

The UI text in this document is the intended Vietnamese copy. As on the Office and Analytics pages, all text inside
this feature is Vietnamese. The rest of the agent page stays English.

## 2. What exists today (verified in this codebase on 2026-11-12)

- **Usage-limit failures.**
  - `claude_local` (ACP) and `codex_local` runs that hit a limit fail with `errorCode: "provider_quota"`.
  - Their error text carries the reset time, for example "You've hit your session limit · resets 8pm (Asia/Bangkok)".
  - The recovery service (`server/src/services/recovery/service.ts`) already turns this into a retry time. In order,
    it uses:
    1. a persisted `retryNotBefore` / `providerQuotaRetryNotBefore`;
    2. a clock time parsed from the error;
    3. a default backoff (`PROVIDER_QUOTA_RECOVERY_DEFAULT_BACKOFF_MS`).
  - It then creates a system-owned "wait for provider quota recovery, then retry the original assignee" action.
  - In the last 241 QUA runs there were 17 `provider_quota` failures: 10 from Claude and 7 from Codex.
- **OpenCode has no usage-limit detection.**
  - `packages/adapters/opencode-local` does not classify quota errors.
  - When OpenCode Go ran out on 2026-11-04, the runs went silent. Output stopped, and nothing ended them until an
    operator cancelled them 15–30 minutes later. See §7.
- **Task sessions are kept per adapter.** `agent_task_sessions` is unique on
  `(company_id, agent_id, adapter_type, task_key)`. Consequences:
  - Switching a task to another adapter starts a fresh session on that adapter. Paperclip's fresh-session handoff
    gives the agent the task context.
  - Switching back to the original adapter can resume that task's earlier session.
- **Quota windows.**
  - `GET /api/companies/:companyId/costs/quota-windows` returns 5-hour and weekly windows from adapters that implement
    `getQuotaWindows()`. Today that is `claude_local` and `codex_local`.
  - For this instance, OpenAI returns real windows. Both Anthropic connections currently return
    "Subscription quota is currently unavailable" (`permission_denied`).
  - So the Claude quota bars will often be empty. The reset time from the error must still be shown.
- **Agent configuration.**
  - The current model lives in the agent's `adapterType` + `adapterConfig`. These are edited on the
    "Harness / Runtime" tab.
  - The account lives separately, in `runtimeConfig.aiConnection`, which is the agent's AI connection binding. The
    run receives the credentials from it, for example `CLAUDE_CODE_OAUTH_TOKEN` or `CODEX_HOME`.
  - Changes are versioned in `agent_config_revisions`.
- **The QUA agents' accounts today.**

  | Account binding | Agents |
  |---|---|
  | Anthropic connection `938f374a` (delegated) | CEO, Project Manager, Tech Lead, Business Analyst |
  | Anthropic connection `b3dd465b` (shared) | DevOps Engineer, Security Engineer, QA Engineer |
  | `responsible_user` (the owner's default) | UI/UX Designer, Backend Engineer |
  | OpenAI connection `ae29dd60` (shared) | Frontend Engineer |

  - OpenCode Go has no AI-connection provider in Paperclip; only OpenRouter has one. So an OpenCode run uses the
    machine's OpenCode login.
  - Every agent has `maxConcurrentRuns: 20`. Runs of the same agent do overlap: 18 of the last 215 runs did.
- **The built-in AI connection router does not fit.**
  - `server/src/services/ai-connection-router.ts` is an experimental account pool.
  - It pins each task to one account and waits when that account is exhausted. It never moves a task mid-way.
  - It switches provider only for `paperclip_runner` agents, but 9 of the 10 QUA agents are `claude_local`.
  - Its OpenCode members accept only OpenRouter models, not OpenCode Go.
  - It needs an experimental flag and a separate router plugin.
  - Do not build on it.

## 3. Goals

### 3.1 Connection chain per agent

1. Each agent has an ordered chain of **connections**.
   - Position 1 is the **default** ("Mặc định", also shown as "Chính"). Positions 2+ are fallbacks ("Dự phòng").
   - A chain may hold any number of connections. One connection (just the default) means fallback is effectively off.
2. A connection is a harness, plus the account it uses, plus a model, plus that harness's model options (thinking
   effort / variant).
   - The **account** is a Paperclip AI connection binding of the same shape as `runtimeConfig.aiConnection`.
   - For a harness with no AI-connection provider, the account is the machine login. Today that means OpenCode Go.
   - The "Tài khoản" picker lists the company's AI connections that are compatible with the chosen harness.
3. The default connection **is** the agent's normal configuration: `adapterType` + `adapterConfig` +
   `runtimeConfig.aiConnection`, as edited on the Harness / Runtime tab.
   - Editing either place edits the same thing, so the two places can never disagree.
   - A run on a fallback connection uses that connection's binding instead of the agent's. Switching to OpenCode
     means the run carries no Anthropic binding.
4. Connection types the owner can add, in this order in the add dialog:
   1. **OpenCode Go**: `opencode_local` with the OpenCode Go login already on the machine.
      - Models: `opencode-go/glm-5.3`, `opencode-go/deepseek-v4.1-flash`, `opencode-go/kimi-k3`,
        `opencode-go/qwen3.8-max`, and whatever else the adapter lists.
   2. **Tài khoản Claude khác**: Claude Code with another Anthropic AI connection from Paperclip.
      - This replaces CCS's separate login directory (`CLAUDE_CONFIG_DIR`). It is the Paperclip-native way to hold a
        second account.
      - Managed connections are also the only accounts that can show quota bars.
   3. **Codex (OpenAI)**: `codex_local` with the Codex login.
   4. **Endpoint tương thích Anthropic**: Claude Code with `ANTHROPIC_BASE_URL` and a token that is stored in Paperclip
      Secrets and referenced by the connection, for example Z.ai's GLM endpoint.
   - The "Claude default account" connection (Claude Code with the machine login) is what the agents use today. It
     must work in any case.
   - Types 1 and 3 are required.
   - Types 2 and 4 are wanted, but the owner was told they might come second. The builder decides whether they ship
     in the first release, and must say which.

### 3.2 Switching rules (agreed with the owner)

5. **Run out → switch at once.**
   - Trigger: a run fails with `provider_quota` while it was using connection N.
   - Mark connection N's **account** as exhausted until its reset time. Use the same reset-time logic as the recovery
     service.
   - Exhaustion belongs to the account, not to the agent.
     - Every other agent whose current connection uses the same account also counts it as exhausted, and switches
       before its next run without failing first.
     - Accounts are identified by the AI connection the run actually resolved; `responsible_user` resolves to a
       concrete connection.
     - For a machine login, the account is the harness itself. All OpenCode Go use is one account.
   - Pick the next connection in the chain whose account is not exhausted.
   - Retry the interrupted task on that connection immediately, instead of waiting for the reset.
6. **Never interrupt a running run.** A switch only affects the next run. A run already in progress finishes on the
   connection it started with.
7. **Stay on the fallback until the task is done** ("ưu tiên xong task trước, rồi quay lại provider cũ").
   - After a switch, the agent keeps using the fallback for the task that triggered the switch, until that task is
     finished.
   - "Finished" means the issue is `done`, `in_review`, `cancelled` or `blocked`, or it is no longer assigned to this
     agent.
   - Having no queued run does **not** count as finished. Most QUA agents only wake on demand, so an unfinished task
     often has no queued run between wakes.
   - Other tasks the agent starts while on the fallback also use the fallback.
8. **Return to the default** when both are true:
   - the task from rule 7 is finished, and
   - the default connection is past its reset time.

   The return happens before the agent's next run starts. It never happens during a run. If the task finishes before
   the reset, the agent stays on the fallback and returns at the first run boundary after the reset.
9. **Fallback also runs out.**
   - If the default is past its reset by then, return to the default.
   - Otherwise move to the next usable connection in the chain.
   - If every connection is exhausted, wait for the earliest reset among them. This is today's behaviour, extended to
     the chain.
10. **"Đặt mặc định" (set as default).**
    - The owner can make any fallback the default. It moves to position 1, and the old default moves down to become a
      fallback.
    - This changes the agent's configuration (it writes an `agent_config_revisions` revision) and applies from the
      next run.
    - From then on, "return to the default" means returning to the new default.
    - If the new default is currently exhausted, accept the change, keep running on the current fallback, and move to
      the new default when its reset time passes.
11. **Off switch.** Each agent has an on/off setting for automatic switching ("Tự động chuyển khi hết token"). When it
    is off, a `provider_quota` failure behaves exactly as today.
12. **Concurrent runs.** An agent can run several tasks at once.
    - Exhaustion is recorded against the connection the failed run actually used, even if the agent has already
      switched since.
    - Rule 7 holds a *set* of triggering tasks. The agent returns to the default only when all of them are finished.
    - When runs are active on two connections at once, the header chip shows the connection of the most recently
      started run, followed by "+1 kết nối khác". The hub marks every connection that has an active run as in use.
13. **Respect every existing control.**
    - A fallback retry is a normal run. It goes through the same admission as any run: company scope, budget hard-stop,
      pause/Stop, task eligibility and issue checkout.
    - It must not become a way around those controls.
    - A switch never changes the agent's instructions, permissions, skills or environment, except for the variables
      the selected connection itself needs.

### 3.3 Initial setup for QUA (configure as part of rollout)

| Agent | Default (today) | Fallback 1 | Fallback 2 |
|---|---|---|---|
| Tech Lead, Backend Engineer, DevOps Engineer, QA Engineer | Claude Code · own account · as configured today | Claude Code · the other Claude account · same model | OpenCode Go · `opencode-go/glm-5.3` |
| Frontend Engineer | Codex · `gpt-6.1-sol` | OpenCode Go · `opencode-go/glm-5.3` | — |
| CEO, Project Manager, Business Analyst, UI/UX Designer, Security Engineer | Claude Code · own account · as configured today | Claude Code · the other Claude account · same model | OpenCode Go · `opencode-go/deepseek-v4.1-flash` |

"The other Claude account" is whichever of the two Anthropic connections the agent does not use by default. The
builder resolves `responsible_user` to the concrete connection first.

Turn automatic switching on for all 10 agents.

### 3.4 UI: new agent tab "Kết nối model"

14. Add a tab **"Kết nối model"** to the agent page's AGENT section, after "Harness / Runtime".
15. **Header.**
    - A live chip shows what the agent is using now, for example "● Đang chạy · OpenCode Go · GLM 5.3". The dot pulses
      while a run is active.
    - When the agent is not on its default, a "Dự phòng N" tag follows, plus a short reason, for example
      "Claude hết token đến 20:00".
    - On the right is one button, **"⚙ Cài đặt chuyển đổi"**. It opens the chain settings:
      - the on/off switch;
      - the wait used when an error gives no reset time;
      - a plain list to reorder the chain, as a keyboard and phone-friendly alternative to drag and drop.
    - There is **no** "return to the default now" button; the owner decided against it.
16. **Stat row.** Four tiles:
    - **Đang dùng:** the model in use.
    - **Task hiện tại:** the issue and elapsed time.
    - **Chuyển hôm nay:** how many switches happened today.
    - **Mặc định:** the default model, and when the agent will return to it, for example
      "quay về khi QUA-42 xong & sau 20:00".
17. **Connection hub** (from CCS's Live Account Monitor).
    - The agent card is on the left: name, role, current issue and tokens today. Each connection is a card on the
      right, in chain order.
    - A curved line joins the agent to each card:
      - the connection in use: a thick, animated line, and its card has a highlighted border with "● Đang dùng";
      - an exhausted connection: a dotted amber line, and its card shows "Hết token · còn 5g 28p" with the reset
        time;
      - a usable but idle connection: a thin grey line and "Sẵn sàng".
    - Each card shows its position ("1 · Chính ★ Mặc định", "2 · Dự phòng"), the harness mark, the provider and the
      model.
    - When quota windows are available for that account, the card shows them as 5h and weekly bars (from CCS Bar).
      When they are not, it shows only the reset time from the error.
    - Each card has "✎" (edit). Each non-default card also has "☆ Đặt mặc định".
    - A dashed card at the end reads "＋ Thêm tài khoản / provider".
    - Cards can be dragged to reorder the chain. Dropping a card at position 1 is the same as "Đặt mặc định".
18. **Timeline** (right column, today by default). One line per event, newest first:
    - runs, with their result and the model they ran on;
    - each switch and return, with its reason and task, for example
      "Chuyển Claude → GLM 5.3 · 14:32 · hết token, reset 20:00";
    - each "Đặt mặc định" made by the owner.
19. **Edit dialog** ("Sửa kết nối N").
    - Fields: Harness, Tài khoản, Model, and the harness's effort/variant option, plus "Xoá kết nối", "Huỷ" and "Lưu".
    - The note says "Đổi model áp dụng từ run tiếp theo; run đang chạy không bị ngắt."
    - Changing Sonnet to Opus is the typical use.
20. **Add dialog** ("Thêm kết nối dự phòng").
    - The connection types are listed as selectable cards with a one-line explanation each.
    - Below them are the fields for the chosen type and a model picker.
    - It has a **"Kiểm tra kết nối"** button. It reuses the existing "Test your agent" check against that connection,
      so the owner can confirm it works before adding it.
    - A new connection goes to the end of the chain.
21. **Other surfaces show the connection in use, not just the configured default.** This covers:
    - the header under the agent's name on every agent tab;
    - the agent cards and model badges on the Office page.

### 3.5 Records

22. Every switch, return, "Đặt mặc định", and chain edit writes an activity log entry, like other mutations.
23. Every switch and return also posts a short comment on the affected issue, for example
    "Claude Sonnet 5.5 hết token (reset 20:00) → chuyển sang OpenCode Go · GLM 5.3 để làm tiếp."
24. Each run must record which connection it used, so the timeline and Analytics show the real model. Cost events
    already record the actual provider and model per run.

## 4. Non-goals

- Switching inside a running run. A run that hits the limit after it started producing output fails and is retried
  on the next connection; it is not continued mid-stream. CCS behaves the same way.
- A company-wide view of all agents' connections. A later version may add one.
- Changing how Paperclip's AI connection router or account pools work.
- Load balancing (round-robin) across accounts. The chain is strictly ordered fallback.
- Notifications to a phone. This is a separate, later piece of work.

## 5. Anti-goals (this would be a failure even if it works)

- The agent silently runs on another provider and the owner cannot tell. Every surface that shows the agent's model
  must show the one in use.
- A run in progress is killed or restarted because of a switch.
- A fallback retry bypasses a budget stop, a pause, or an issue checkout.
- The Harness / Runtime tab and the chain disagree about the default.
- Account tokens or endpoint keys appear in the UI, in logs, in comments, or in the activity log.

## 6. Constraints

- Follow `AGENTS.md`:
  - company scoping;
  - contracts synchronized across `packages/db`, `packages/shared`, `server`, `ui`;
  - activity logging for mutations;
  - the UI token-only rule (`pnpm check:token-gates`).
- Follow `rules/heartbeat-execution-boundaries.mdc`. The switching policy is new behaviour, so it belongs in its own
  module. Candidates are under `server/src/services/heartbeat/` or next to the recovery service. `heartbeat.ts` gets
  only small wiring.
- A database change follows the repo's migration workflow (`pnpm db:generate`).
- **Do not disturb the running instance** (agreed with the owner).
  - `~/paperclip` is the live copy. It runs `pnpm dev` in watch mode with migrations auto-applied.
  - Build in a separate git worktree on a feature branch, with its own dev instance: its own database and its own
    port, for example 3101.
  - The live server, its database and the 10 agents are untouched until cut-over.
  - At cut-over:
    1. back up the live database;
    2. pick a moment when the agents are idle;
    3. merge into local `master`;
    4. let the live server apply the migration;
    5. apply the §3.3 chains.
- Vietnamese copy lives in one strings module, as `ui/src/lib/office/strings.ts` and `ui/src/lib/analytics/strings.ts`
  do.

## 7. Known gap: OpenCode does not report its limit

When OpenCode Go runs out, OpenCode does not fail. It goes silent. So:

- **Claude → OpenCode** (the common case) works: Claude reports `provider_quota`.
- **OpenCode → next connection** cannot fire, because nothing reports the limit.

The builder must look at what OpenCode prints or returns when it hits the limit and classify it as `provider_quota`
if possible. If OpenCode gives no signal at all, the builder reports that back, and the owner decides about a
no-output watchdog. Do not invent a silent-timeout rule without the owner.

## 8. Left to the builder

- Where the chain and its live state are stored. This could be a new table, part of the agent's config, or a mix.
  The chain must be versioned with the agent's config. Exhausted-until times and the "stay until task X is finished"
  marker are live state.
- How a run is made to use a non-default connection. Recommended: apply the fallback as a per-run override of harness
  and model, like the AI connection router's `applyAiConnectionRouterTaskSettings`, rather than rewriting the agent's
  saved config on every switch. The saved config stays the default.
- How the "task finished" condition in rule 7 is detected.
- The component structure of the tab and how the hub diagram is drawn. It must stay within the token layer and work
  in light and dark mode.
- Whether types 2 and 4 in goal 4 ship in the first release.

## 9. Decisions made by the assistant (owner may override)

- The tab name is "Kết nối model", and its text is Vietnamese while the rest of the agent page stays English.
- Every switch also posts an issue comment, not only an activity log entry.
- The chain settings have no "return-rule" choice. Only the agreed rule (task finished and past reset) exists.
- The wait used when an error gives no reset time defaults to Paperclip's existing provider-quota backoff and can be
  changed in "Cài đặt chuyển đổi".
- Dragging a card to position 1 counts as "Đặt mặc định".
- The tiles, hub, and timeline cover today only. A longer history is a non-goal.
- A second Claude account is a second Anthropic AI connection, not a `CLAUDE_CONFIG_DIR` login.
- Exhaustion is tracked per account, and all agents on that account switch together (rule 5). The owner confirmed
  the two Claude connections are different accounts. The assistant then applied the per-account rule the owner had
  been offered for the shared-account case.
- §3.3 puts the other Claude account before OpenCode. Once the owner confirmed there are two Claude accounts, keeping
  agents on Claude Code (same tools, same session format) before leaving Claude was judged the better first step. The
  OpenCode models are the ones the owner chose.
- Concurrent runs are handled as in rule 12.
- This is local-only work, like the Office/Analytics commit: no upstream PR and no push. Vietnamese-only copy and the
  QUA-specific setup are therefore fine.
- The builder applies the §3.3 chains to the live QUA agents through the API after the feature is deployed.
