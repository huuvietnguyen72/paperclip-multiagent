# Agent Model Fallback ("Kết nối model") Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each agent an ordered chain of connections (harness + account + model). When the connection in use hits
its usage limit, the agent moves to the next usable connection and the interrupted task is retried at once. A new agent
tab, "Kết nối model", shows which connection is in use.

**Architecture:**

- **Where the chain lives.** The fallbacks live in `agents.runtimeConfig.modelFallback`. The default is the agent's own
  `adapterType` + `adapterConfig` + `runtimeConfig.aiConnection`. Storing the chain in the agent's config means it is
  versioned with the rest of the config.
- **Live state.** Two small tables hold it. One holds each agent's active connection and its pinned issues. The other
  holds each account's exhausted-until time.
- **Choosing the connection.** The connection is chosen when a queued run is **claimed**, in `heartbeat/queue.ts`. The
  choice is written into the run's `runnerProfileJson.adapterDispatch` claim. When the run starts, `heartbeat.ts` applies
  that recorded choice as a per-run override.
- **Run failures.** A `provider_quota` failure is handled in `heartbeat/run-completion.ts`. It records the exhaustion
  and schedules an immediate retry.
- **Where the policy code goes.** The policy is pure functions in `server/src/services/model-fallback/`. Heartbeat files
  get only wiring.

**Tech Stack:** TypeScript, Drizzle/Postgres, Express, zod (`@paperclipai/shared`), React + TanStack Query, Vitest
(embedded Postgres for DB tests).

**Spec:** `doc/plans/2026-11-12-agent-model-fallback-design.md` (approved 2026-11-12). Section and rule numbers below
(§3.2 rule 5, …) refer to it.

## Global Constraints

### Workspace

- **Isolated workspace.** Never edit, build or check out branches in `~/paperclip`: it is the live instance (`pnpm dev`,
  watch mode, migrations auto-applied).
- **Setup.** Work in a linked git worktree `~/paperclip-fallback` on branch `feat/model-fallback`, created from local
  `master`:
  - run `git worktree add ../paperclip-fallback -b feat/model-fallback`;
  - then, inside it, run `pnpm install` and `pnpm paperclipai worktree init --seed-mode minimal`. This gives the worktree
    its own `.paperclip/.env`, database and port. Write the port down.
- **Shell.** Run commands in WSL. From Git Bash, use `MSYS_NO_PATHCONV=1 wsl -d Ubuntu --exec bash -lc 'source ~/.nvm/nvm.sh >/dev/null; source ~/.cargo/env; cd ~/paperclip-fallback && <cmd>'`.
- **Memory.** WSL memory is limited. Do not run the worktree's `pnpm dev` and a full `pnpm build` at the same time. For
  repo-wide typecheck, use `node scripts/typecheck-low-memory.mjs`.

### Repository rules

- Follow `AGENTS.md`:
  - company scoping on every query;
  - contracts synced across `packages/db`, `packages/shared`, `server`, `ui`;
  - an activity log entry for every mutation;
  - `pnpm check:token-gates` clean, which means no hex, raw px, arbitrary Tailwind values or raw font sizes in
    `ui/src/components/**` and `ui/src/pages/**`.
- Follow `rules/heartbeat-execution-boundaries.mdc`. `heartbeat.ts`, `heartbeat/queue.ts` and
  `heartbeat/run-completion.ts` get wiring only, at most about 15 lines each. Policy lives in
  `server/src/services/model-fallback/`.
- A fallback retry is an ordinary run. It must not skip invokability, budget, pause/Stop, daily cap or issue checkout.
  Those checks already run in `claimQueuedRun` before the claim writes.

### Fixed values

- **Exact strings:**

  | Name | Value |
  |---|---|
  | Default connection id | `"default"` |
  | Retry reason | `"model_fallback_switch"` |
  | Wake reason | `"model_fallback_switch"` |
  | Activity actions | `"agent.model_fallback.switched"`, `"agent.model_fallback.returned"` |
  | Account key | `ai:<connectionId>` for an AI-connection binding; `login:<adapterType>` for a machine login (OpenCode) |

- **Issue statuses that count as "finished"** (§3.2 rule 7): `done`, `in_review`, `cancelled`, `blocked`. An issue no
  longer assigned to the agent also counts as finished.
- **Keys carried from the agent's own `adapterConfig` into any fallback run** (`MODEL_FALLBACK_CARRY_KEYS`):
  - `cwd`
  - `instructionsFilePath`
  - `instructionsRootPath`
  - `instructionsEntryFile`
  - `instructionsBundleMode`
  - `paperclipSkillSync`
  - `promptTemplate`
  - `env`
  - `timeoutSec`
  - `graceSec`

  Every other key comes from the connection's own `adapterConfig`.
- **Limits.** At most 10 fallback connections per agent. The default for "wait when no reset time is known" is the
  recovery service's `PROVIDER_QUOTA_RECOVERY_DEFAULT_BACKOFF_MS`.

### UI

- All copy is Vietnamese and lives in `ui/src/lib/model-fallback/strings.ts`. The strings are listed in Task 8.
- The tab name is "Kết nối model". The URL view is `connections`, for example `/QUA/agents/backend-engineer/connections`.

### Commits

- One commit per task on `feat/model-fallback`. Pass the author with
  `-c user.name=huuvietnguyen72 -c user.email=<owner email from git context>`.
- End each message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Never push.

## Review Focus

1. **The agent's `responsible_user` binding has no default for the run's user.** Building the account key must not
   throw and fail the claim. Treat that connection as unusable for selection and keep the run on today's behaviour.
   Test: Task 5, `accountKeyFor returns null when responsible_user has no default`.
2. **A fallback connection is deleted from the chain while the agent is on it.** The next claim falls back to
   selection from the default, and the stale `activeConnectionId` is cleared. Test: Task 3, `stale active id resolves
   to default`.
3. **A `provider_quota` failure on a run claimed before this feature existed**, so it has no `modelFallback` dispatch
   record. Today's behaviour must be unchanged: no switch and no exhaustion row. Test: Task 6,
   `quota failure without dispatch record keeps legacy path`.
4. **The retry run must not inherit the failed run's session.** `agent_task_sessions` is keyed by adapter type, so a
   Claude session must not be resumed under `opencode_local`. Test: Task 6,
   `fallback run uses the fallback adapter's task session`.
5. **Both Claude accounts are exhausted and OpenCode is usable.** CEO-group agents must reach OpenCode, which is
   fallback 2. They must not wait on Claude account B. Test: Task 3, `skips every exhausted account in order`.

---

### Task 1: Shared contracts

**Files:**
- Create: `packages/shared/src/model-fallback.ts`
- Modify: `packages/shared/src/validators/agent.ts:72-85` (add `modelFallback` to `agentRuntimeConfigSchema`)
- Modify: `packages/shared/src/index.ts` (export the new module)
- Test: `packages/shared/src/model-fallback.test.ts`

**Interfaces:**
- Produces:
  - `MODEL_FALLBACK_DEFAULT_CONNECTION_ID = "default"`, `MODEL_FALLBACK_RETRY_REASON = "model_fallback_switch"`,
    `MODEL_FALLBACK_FINISHED_ISSUE_STATUSES: readonly string[]`, `MODEL_FALLBACK_CARRY_KEYS: readonly string[]`,
    `MODEL_FALLBACK_MAX_CONNECTIONS = 10`.
  - `modelFallbackConnectionSchema` → `ModelFallbackConnection`:
    `{ id: string /* uuid */, adapterType: AgentAdapterType, adapterConfig: Record<string, unknown>, aiConnection?: AiRuntimeConnectionBinding }`.
  - `modelFallbackConfigSchema` → `ModelFallbackConfig`:
    `{ enabled: boolean, connections: ModelFallbackConnection[], noResetWaitMinutes?: number /* 1..1440 */ }`.
  - `ModelFallbackDispatchRecord`:
    `{ connectionId: string, accountKey: string | null, adapterType: string, model: string | null, isFallback: boolean }`.
  - `AgentModelFallbackView` (the GET response from Task 7):
    `{ enabled, noResetWaitMinutes, active: { connectionId, since: string | null, reason: string | null }, pinnedIssues: Array<{ id, identifier, title, status, finished: boolean }>, connections: Array<{ id, position: number, isDefault: boolean, adapterType, model: string | null, aiConnection: AiRuntimeConnectionBinding | null, accountKey: string | null, accountLabel: string | null, exhaustedUntil: string | null, inUse: boolean, lastUsedAt: string | null, runsToday: number, tokensToday: number, quotaWindows: Array<{ label: string, usedPercent: number | null, resetsAt: string | null }> }>, today: { switches: number, tokens: number }, timeline: Array<{ at: string, kind: "run" | "switched" | "returned" | "default_changed", status?: string, issueIdentifier?: string | null, fromModel?: string | null, toModel?: string | null, model?: string | null, durationMs?: number | null, reason?: string | null, resetAt?: string | null }> }`.
  - `CompanyModelFallbackActive`:
    `Array<{ agentId: string, connectionId: string, adapterType: string, model: string | null, isFallback: boolean }>`.

- [ ] **Step 1: Write the failing tests** in `model-fallback.test.ts`:
  - `accepts a chain with an opencode fallback`: a `modelFallbackConfigSchema.parse` of
    `{ enabled: true, connections: [{ id: <uuid>, adapterType: "opencode_local", adapterConfig: { model: "opencode-go/glm-5.3" } }] }`
    succeeds.
  - `rejects more than 10 connections`.
  - `rejects a connection without adapterConfig.model`.
  - `agentRuntimeConfigSchema keeps modelFallback`: parsing `{ modelFallback: {...valid} }` returns it unchanged.
- [ ] **Step 2: Run it.**
  - Run: `cd packages/shared && pnpm exec vitest run src/model-fallback.test.ts`.
  - Expected: FAIL, because the module is not found.
- [ ] **Step 3: Implement the module and add the schema key.**
  - `adapterConfig.model` must be a non-empty string.
  - Connection ids must be unique.
- [ ] **Step 4: Run again.** Expected: 4/4 PASS. Then run `pnpm --filter @paperclipai/shared typecheck`. Expected: 0
  errors.
- [ ] **Step 5: Commit** with the message `feat(shared): model fallback contracts`.

### Task 2: Database tables

**Files:**
- Create: `packages/db/src/schema/agent_model_fallback_states.ts`
- Create: `packages/db/src/schema/model_account_exhaustions.ts`
- Modify: `packages/db/src/schema/index.ts`
- Generated: the migration from `pnpm db:generate`

**Interfaces:**
- Produces:
  - `agentModelFallbackStates`:
    - columns: `id uuid pk`, `companyId uuid not null → companies`, `agentId uuid not null → agents (cascade)`,
      `activeConnectionId text null`, `pinnedIssueIds jsonb string[] not null default []`, `switchedAt timestamptz null`,
      `reason text null`, `updatedAt timestamptz not null default now()`;
    - unique on `(companyId, agentId)`.
  - `modelAccountExhaustions`:
    - columns: `id uuid pk`, `companyId uuid not null → companies`, `accountKey text not null`,
      `exhaustedUntil timestamptz not null`, `sourceRunId uuid null → heartbeat_runs (set null)`,
      `parsedResetTime boolean not null`, `updatedAt timestamptz not null default now()`;
    - unique on `(companyId, accountKey)`.

- [ ] **Step 1: Write both schema files** following `agent_config_revisions.ts`, and export them from `index.ts`.
- [ ] **Step 2: Generate the migration.**
  - Run: `pnpm db:generate`.
  - Expected: one new migration that creates exactly these two tables and their indexes.
- [ ] **Step 3: Typecheck.**
  - Run: `pnpm --filter @paperclipai/db typecheck`.
  - Expected: 0 errors.
- [ ] **Step 4: Commit** the schema files and the migration with the message
  `feat(db): model fallback state tables`.

### Task 3: Selection policy (pure)

**Files:**
- Create: `server/src/services/model-fallback/policy.ts`
- Test: `server/src/services/model-fallback/policy.test.ts`

**Interfaces:**
- Consumes: Task 1 contracts.
- Produces:
  - `type ChainEntry = { id: string; adapterType: string; adapterConfig: Record<string, unknown>; aiConnection: AiRuntimeConnectionBinding | null }`.
  - `buildChain(agent: { adapterType: string; adapterConfig: unknown; runtimeConfig: unknown }): ChainEntry[]`.
    - Index 0 is the default, with id `"default"`.
    - It is followed by `runtimeConfig.modelFallback.connections`, unless the config is missing, invalid or
      `enabled: false`. In those cases it returns only the default.
  - `effectiveRunAgent<A extends { adapterType: string; adapterConfig: unknown; runtimeConfig: unknown }>(agent: A, entry: ChainEntry): A`.
    - For the default it returns the agent unchanged.
    - Otherwise it returns `adapterType = entry.adapterType`.
    - The returned `adapterConfig` is `{ ...pick(agent.adapterConfig, MODEL_FALLBACK_CARRY_KEYS), ...entry.adapterConfig }`.
    - In the returned `runtimeConfig`, `aiConnection` is `entry.aiConnection`. The key is removed when that is null.
  - `selectConnection(input: { chain: ChainEntry[]; accountKeys: (string | null)[]; exhaustedUntil: Map<string, Date>; activeConnectionId: string | null; pinnedFinished: boolean; now: Date }): { index: number; kind: "default" | "stay" | "return" | "switch" | "all_exhausted" }`.

  `selectConnection` follows the spec. Its order of rules:
  1. An entry is *usable* when its account key is non-null and not exhausted at `now`.
  2. Treat a missing `activeConnectionId`, or one no longer in the chain, as index 0.
  3. If the current entry is a fallback, `pinnedFinished` is true and index 0 is usable, return `{ 0, "return" }`.
  4. Else, if the current entry is usable, return it. The kind is `"default"` for index 0 and `"stay"` otherwise.
  5. Else, return the first usable index in chain order, with kind `"switch"`.
  6. Else, return the index with the earliest `exhaustedUntil`, with kind `"all_exhausted"`.

  An entry whose key is null is never usable. If every key is null, return `{ 0, "default" }`.

- [ ] **Step 1: Write the failing tests.**

  | Test | Setup | Expected |
  |---|---|---|
  | `no fallback config returns only default` | — | `buildChain(...).length === 1` |
  | `disabled config returns only default` | `enabled: false` | only the default |
  | `effectiveRunAgent carries instructions and swaps model` | agent `claude_local` with `{ instructionsFilePath: "/i.md", model: "claude-sonnet-5-5", dangerouslySkipPermissions: true }`; entry `opencode_local` `{ model: "opencode-go/glm-5.3" }` | `adapterType === "opencode_local"`; `adapterConfig` equals `{ instructionsFilePath: "/i.md", model: "opencode-go/glm-5.3" }`; `runtimeConfig.aiConnection === undefined` |
  | `default usable stays on default` | — | `{ 0, "default" }` |
  | `default exhausted switches to first usable` | chain `[A, B, C]`, A exhausted | `{ 1, "switch" }` |
  | `skips every exhausted account in order` | A and B exhausted, C usable | `{ 2, "switch" }` |
  | `stays on fallback while pinned unfinished` | active B, A usable, `pinnedFinished: false` | `{ 1, "stay" }` |
  | `returns when pinned finished and default reset` | active B, A usable, `pinnedFinished: true` | `{ 0, "return" }` |
  | `does not return while default still exhausted` | active B, A exhausted, `pinnedFinished: true` | `{ 1, "stay" }` |
  | `fallback exhausted returns to reset default` | active B, B exhausted, A usable, `pinnedFinished: false` | `{ 0, "switch" }` (first usable) |
  | `all exhausted picks earliest reset` | A until 20:00, B until 18:00 | `{ 1, "all_exhausted" }` |
  | `stale active id resolves to default` | `activeConnectionId: "gone"` | `{ 0, "default" }` |

- [ ] **Step 2: Run it.**
  - Run: `cd server && pnpm exec vitest run src/services/model-fallback/policy.test.ts`.
  - Expected: FAIL, because the module is not found.
- [ ] **Step 3: Implement `policy.ts`.**
- [ ] **Step 4: Run again.** Expected: 12/12 PASS.
- [ ] **Step 5: Commit** with the message `feat(server): model fallback selection policy`.

### Task 4: Extract the provider-quota reset-time reader

**Files:**
- Create: `server/src/services/recovery/provider-quota-retry-at.ts`
- Modify: `server/src/services/recovery/service.ts:~700-735`. The inline reset-time logic in the `provider_quota`
  branch becomes a call to the new function.
- Test: `server/src/services/recovery/provider-quota-retry-at.test.ts`

**Interfaces:**
- Produces:
  - `resolveProviderQuotaRetryAt(run: { error: string | null; resultJson: unknown }, now: Date, defaultBackoffMs?: number): { retryAt: Date; parsedResetTime: boolean }`.
  - The order is unchanged:
    1. persisted `retryNotBefore` / `transientRetryNotBefore` / `providerQuotaRetryNotBefore`, when it is in the future;
    2. `parseProviderQuotaClockReset(error, now)`;
    3. `now + (defaultBackoffMs ?? PROVIDER_QUOTA_RECOVERY_DEFAULT_BACKOFF_MS)`.

- [ ] **Step 1: Write the failing tests.**
  - `persisted future retryNotBefore wins`.
  - `parses "resets 8pm (Asia/Bangkok)"`: with `now = 2026-11-12T07:00:00Z`, expect
    `retryAt.toISOString() === "2026-11-12T13:00:00.000Z"` and `parsedResetTime: true`.
  - `falls back to default backoff`: an error without a time gives `parsedResetTime: false` and
    `retryAt = now + backoff`.
- [ ] **Step 2: Run it.** Expected: FAIL, because the module is not found.
- [ ] **Step 3: Move the logic**, and call the new function from `service.ts`.
- [ ] **Step 4: Run the new test and `src/services/recovery/` tests.**
  - Run: `cd server && pnpm exec vitest run src/services/recovery`.
  - Expected: all PASS, including the existing recovery tests, which shows the behaviour did not change.
- [ ] **Step 5: Commit** with the message `refactor(recovery): extract provider quota retry-at reader`.

### Task 5: Model fallback service (DB)

**Files:**
- Create: `server/src/services/model-fallback/service.ts`
- Test: `server/src/services/model-fallback/service.test.ts`. It uses embedded Postgres, following
  `heartbeat/agent-status.test.ts`.

**Interfaces:**
- Consumes:
  - Task 2 tables;
  - Task 3 `buildChain`, `selectConnection`;
  - Task 4 `resolveProviderQuotaRetryAt`;
  - `aiConnectionService(db).select(...)` for the resolved `attribution.connectionId`;
  - `logActivity`;
  - `issueService(db).addComment(issueId, body, { runId }, { authorType: "system", presentation: { kind: "system_notice", tone: "info", title, density: "compact", detailsDefaultOpen: false } })`.
- Produces `createModelFallbackService(db: Db, deps?: { now?: () => Date })` with:
  - `accountKeyFor(input: { companyId: string; agentId: string; responsibleUserId: string | null; entry: ChainEntry }): Promise<string | null>`
    - Returns `ai:<connectionId>` from `select()`.
    - Returns `login:<adapterType>` when the entry has no `aiConnection` **and** the adapter is `opencode_local`.
    - Returns `null` when `select()` throws.
    - For a non-OpenCode entry without a binding, returns `login:<adapterType>`.
  - `selectForDispatch(input: { agent: AgentRow; run: HeartbeatRunRow; responsibleUserId: string | null }): Promise<{ adapterType: string; record: ModelFallbackDispatchRecord | null }>`
    - Returns `record: null` when the chain has only the default. This is the legacy path.
    - Otherwise it builds the chain and account keys, loads the exhaustion rows and the state row, and computes
      `pinnedFinished`.
    - It calls `selectConnection`, and persists the transition:
      - **`switch`:** set the active id, add the run's issue id to the pin set, and log
        `agent.model_fallback.switched` with `details: { from, to, reason: "account_exhausted", resetAt }`. Comment
        `switchedComment` on the run's issue.
      - **`return`:** set the active id to null, clear the pins, and log `agent.model_fallback.returned`. Comment
        `returnedComment` on the run's issue.
      - **`stay`:** add the run's issue id to the pins only if it was empty, and only when the agent is on a fallback.
    - It returns the chosen entry's `adapterType` and record.
  - `recordQuotaFailure(input: { run: HeartbeatRunRow; agent: AgentRow }): Promise<{ retryNow: boolean }>`
    - It reads the run's `runnerProfileJson.adapterDispatch.modelFallback` record.
    - With no record, or `accountKey: null`, it returns `{ retryNow: false }` and writes nothing.
    - Otherwise it upserts the exhaustion row for that account, until `resolveProviderQuotaRetryAt(...)`. The backoff
      uses `noResetWaitMinutes` when it is set.
    - It returns `retryNow: true` when `selectConnection` (with `activeConnectionId` = the failed connection and
      `pinnedFinished: false`) gives any usable index other than the failed one.
    - It does not change the active id. The next claim's `selectForDispatch` performs and records the switch.
  - `readAgentView(input: { companyId: string; agentId: string; now?: Date }): Promise<AgentModelFallbackView>`.
    - `today` is the local day of the server process.
    - Timeline sources:
      - this agent's runs today, where the model comes from the run's dispatch record, or from `usageJson.model` as a
        fallback;
      - the `agent.model_fallback.*` activity rows today;
      - `agent_config_revisions` today that changed `adapterType`, `adapterConfig.model` or `runtimeConfig.aiConnection`.
        These show as `default_changed`.
    - It returns the newest 50 events, newest first.
    - `quotaWindows` come from `fetchCompanyQuotaWindows`, matched on the connection's account. If the call fails or
      takes more than 5 s, return empty arrays.
  - `readCompanyActive(companyId: string): Promise<CompanyModelFallbackActive>`. It covers agents whose state has a
    non-null active id.
- Comment copy. It is built here, not in the UI, because these are issue comments:
  - `switchedComment`: `"{fromModel} hết token (reset {HH:mm}) → chuyển sang {toLabel} để làm tiếp."`
  - `returnedComment`: `"{fromLabel} → quay về {toLabel} (mặc định)."`

  Times are `HH:mm` in the server's local timezone. A label is `<harness name> · <model>`, using the names
  "Claude Code", "Codex" and "OpenCode Go".

- [ ] **Step 1: Write the failing tests.** Seed a company, one agent `claude_local` with a fallback `opencode_local`
  `opencode-go/glm-5.3`, an issue, and one run.
  - `selectForDispatch returns null record when no chain`.
  - `accountKeyFor returns null when responsible_user has no default`.
  - `quota failure records exhaustion for the run's account`. After `recordQuotaFailure`, the
    `model_account_exhaustions` row for `ai:<conn>` has the parsed reset, and `retryNow === true`.
  - `quota failure without dispatch record keeps legacy path`. Expect `retryNow === false` and no row.
  - `next dispatch switches and pins the issue`. Expect `adapterType === "opencode_local"`, the state's active id to be
    the fallback id, `pinnedIssueIds` to contain the issue, one activity row `agent.model_fallback.switched`, and one
    system comment containing `"chuyển sang OpenCode Go · opencode-go/glm-5.3"`.
  - `other agent on the same account switches before failing`. A second agent bound to the same connection is
    dispatched while the account is exhausted. Expect its first dispatch to be a fallback.
  - `returns after pinned issue done and reset passed`. Set the issue to `done` and move the exhaustion into the past.
    Expect the next dispatch to have `kind` return, `adapterType === "claude_local"`, and one
    `agent.model_fallback.returned` row.
  - `blocked issue counts as finished`.
  - `readAgentView marks in-use and exhausted connections`.
- [ ] **Step 2: Run it.**
  - Run: `cd server && pnpm exec vitest run src/services/model-fallback/service.test.ts`.
  - Expected: FAIL, because the module is not found.
- [ ] **Step 3: Implement `service.ts`.** Every query filters on `companyId`.
- [ ] **Step 4: Run again.** Expected: 9/9 PASS.
- [ ] **Step 5: Commit** with the message `feat(server): model fallback service`.

### Task 6: Wire into heartbeat (claim, start, completion)

**Files:**
- Modify: `server/src/services/heartbeat/queue.ts`, `claimQueuedRun`, which has three claim writes at ~1287, ~1394 and
  ~1461. Each one writes `adapterDispatch: { adapterType: agent.adapterType }`.
- Modify: `server/src/services/heartbeat.ts` at ~2044-2052, immediately after `let agent = loadedAgent;`.
- Modify: `server/src/services/heartbeat/run-completion.ts` at ~955, before the
  `readTransientRecoveryContractFromRun` branch.
- Modify: the dependency wiring that builds the queue and the run completion. Pass the Task 5 service the same way
  the other dependencies are passed.
- Test: `server/src/services/model-fallback/wiring.test.ts`, plus the existing `heartbeat/queue.test.ts` and
  `heartbeat/run-completion.test.ts` suites.

**Interfaces:**
- Consumes: Task 5 `selectForDispatch`, `recordQuotaFailure`; Task 3 `buildChain`, `effectiveRunAgent`.
- Produces:
  - Each claimed run's `runnerProfileJson.adapterDispatch` is `{ adapterType, modelFallback?: ModelFallbackDispatchRecord }`.
  - A new exported helper in `model-fallback/policy.ts`:
    `applyModelFallbackDispatch<A>(agent: A, run: { runnerProfileJson: unknown }): { agent: A; missing: boolean }`.
    - When the record is present and `isFallback`, it returns `{ agent: effectiveRunAgent(agent, entry), missing: false }`.
      `entry` is found by `connectionId` in `buildChain(agent)`.
    - When the record's connection is no longer in the chain, it returns `{ agent, missing: true }`.
    - Otherwise it returns `{ agent, missing: false }`.

- [ ] **Step 1: Write the failing tests** in `wiring.test.ts`:
  - `applyModelFallbackDispatch swaps adapter for fallback record`.
  - `applyModelFallbackDispatch leaves agent when record missing`.
  - `applyModelFallbackDispatch leaves agent when connection removed`. It returns `{ agent, missing: true }`.
  - `fallback run uses the fallback adapter's task session`. Call the real `getTaskSession` lookup path with the
    overridden agent. The key used must be `opencode_local`.
  - `quota failure without dispatch record keeps legacy path`. In the `run-completion.test.ts` style, a `provider_quota`
    failed run with no record must call `scheduleBoundedRetryForRun(run, agent)` with no options, exactly as today.
  - `quota failure with usable fallback retries immediately`. With `recordQuotaFailure` resolving
    `{ retryNow: true }`, expect `scheduleBoundedRetryForRun(run, agent, { retryReason: "model_fallback_switch", wakeReason: "model_fallback_switch", delayMs: 0, maxAttempts: <chain length> })`
    and no transient retry call.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Wire it in.**
  - **queue.ts:** after the daily-cap check and before the claim transaction, call
    `const dispatch = await modelFallback.selectForDispatch({ agent, run, responsibleUserId })`. Use one local
    `adapterDispatchJson` in all three claim writes.
  - **heartbeat.ts:** after `let agent = loadedAgent;`, call `({ agent } = applyModelFallbackDispatch(agent, run))`.
    Do this before the `claimedAdapterType` check, so the claim and the agent agree. When `missing`, append a `warn`
    run event.
  - **run-completion.ts:** when `outcome === "failed"` and the error family is `provider_quota`, call
    `recordQuotaFailure`. If `retryNow`, schedule as in the test, and skip the transient branch.
- [ ] **Step 4: Run** `wiring.test.ts`, `heartbeat/queue.test.ts`, `heartbeat/run-completion.test.ts` and
  `heartbeat/retries.test.ts`. Expected: all PASS.
- [ ] **Step 5: Check that the wiring stayed small.** Run `git diff --stat` on the three heartbeat files. Expected:
  each one at most about 15 added lines.
- [ ] **Step 6: Commit** with the message `feat(heartbeat): route runs through the model fallback chain`.

### Task 7: API routes and PATCH validation

**Files:**
- Create: `server/src/routes/model-fallback.ts`, registered beside the agents router.
- Modify: `server/src/routes/agents.ts`, the `PATCH /agents/:id` handler at ~5460. When the body's `runtimeConfig`
  carries `modelFallback`, validate each connection:
  - `isAiConnectionCompatible(binding, adapterType, model)` holds when a binding is present;
  - `adapterType` is one of `claude_local`, `codex_local`, `opencode_local`.

  Respond `422` with a Vietnamese-free English error message, as the rest of the route does.
- Modify: `server/src/routes/openapi.ts`, if routes are registered there.
- Test: `server/src/__tests__/model-fallback-routes.test.ts`, following an existing route test such as
  `adapter-model-refresh-routes.test.ts`.

**Interfaces:**
- Consumes: Task 5 `readAgentView`, `readCompanyActive`.
- Produces:
  - `GET /api/agents/:id/model-fallback` → `AgentModelFallbackView`, after the same access check as `GET /agents/:id`.
  - `GET /api/companies/:companyId/model-fallback/active` → `CompanyModelFallbackActive`, after the company access
    check.
- The chain is edited with the existing `PATCH /api/agents/:id` (`runtimeConfig.modelFallback`). "Đặt mặc định" uses
  the same PATCH: it swaps the default's `adapterType`, `adapterConfig` and `runtimeConfig.aiConnection` with the
  chosen connection's. That keeps revisions and activity logging in one place.

- [ ] **Step 1: Write the failing tests.**
  - `GET view returns 404 for an agent in another company`.
  - `GET view returns default-only chain for an agent without config`.
  - `PATCH rejects an incompatible binding`: an `opencode_local` connection with an Anthropic binding returns 422.
  - `PATCH accepts a valid chain and writes one config revision`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them.** Expected: 4/4 PASS.
- [ ] **Step 5: Commit** with the message `feat(server): model fallback routes`.

### Task 8: UI data layer and copy

**Files:**
- Create: `ui/src/api/model-fallback.ts`, `ui/src/lib/model-fallback/strings.ts`, `ui/src/lib/model-fallback/format.ts`
- Modify: `ui/src/lib/queryKeys.ts`
- Test: `ui/src/lib/model-fallback/format.test.ts`

**Interfaces:**
- Produces:
  - `modelFallbackApi.agentView(agentId, companyId)`, `modelFallbackApi.companyActive(companyId)`.
  - `queryKeys.modelFallback.agent(agentId)`, `queryKeys.modelFallback.company(companyId)`.
  - `formatRemaining(until: Date, now: Date): string`. Examples: "còn 5g 28p", "còn 12p", "còn <1p".
  - `connectionLabel(adapterType, model): string`. It reuses `modelBadgeFor` from `ui/src/lib/office/model-badge.ts`
    for the pretty model name. Example: "OpenCode Go · GLM 5.3".
  - `swapDefault(agent, connectionId): { adapterType, adapterConfig, runtimeConfig }`. This is the PATCH body for
    "Đặt mặc định":
    - the old default becomes a fallback, at the chosen connection's position, with a new uuid;
    - the old default's own keys (minus `MODEL_FALLBACK_CARRY_KEYS`) become that fallback's `adapterConfig`;
    - the carry keys stay on the agent.
- `strings.ts`. Exact copy, from the spec and the approved mockup:

  | Area | Strings |
  |---|---|
  | Tab | tab `"Kết nối model"` |
  | Header | running `"Đang chạy"`; fallback tag `"Dự phòng {n}"`; reason `"{label} hết token đến {HH:mm}"`; more `"+{n} kết nối khác"`; settings `"⚙ Cài đặt chuyển đổi"` |
  | Stat tiles | `"Đang dùng"`, `"Task hiện tại"`, `"Chuyển hôm nay"`, `"Mặc định"`; return `"quay về khi {issues} xong & sau {HH:mm}"` |
  | Hub | title `"Live · sơ đồ kết nối"`; positions `"Chính"`, `"★ Mặc định"`, `"Dự phòng"`; states `"● Đang dùng"`, `"Hết token · {remaining}"`, `"Sẵn sàng"`; actions `"☆ Đặt mặc định"`, `"＋ Thêm tài khoản / provider"`; quota rows `"5h"`, `"tuần"` |
  | Timeline | title `"Dòng thời gian"`; `"hôm nay"`; switch `"Chuyển {from} → {to}"`; return `"Quay về {to}"`; set default `"Đổi mặc định: {from} → {to}"`; quota reason `"hết token, reset {HH:mm}"` |
  | Edit dialog | title `"Sửa kết nối {n}"`; note `"Đổi model áp dụng từ run tiếp theo; run đang chạy không bị ngắt."`; fields `"Harness"`, `"Tài khoản"`, `"Model"`, `"Thinking effort"`; buttons `"Xoá kết nối"`, `"Huỷ"`, `"Lưu"` |
  | Add dialog | title `"Thêm kết nối dự phòng"`; note `"Thêm vào cuối chuỗi; kéo thả trên sơ đồ để đổi thứ tự."`; type labels with descriptions (`"OpenCode Go"`, `"Tài khoản Claude khác"`, `"Codex (OpenAI)"`, `"Endpoint tương thích Anthropic"`); `"Kiểm tra kết nối"`, `"Thêm"` |
  | Settings dialog | `"Tự động chuyển khi hết token"`; `"Thời gian chờ khi không rõ giờ reset (phút)"`; `"Thứ tự kết nối"` |
  | States | `"Đang tải…"`, `"Không tải được thông tin kết nối."` |

- [ ] **Step 1: Write the failing tests.**
  - `formatRemaining hours and minutes`: 5h28m → `"còn 5g 28p"`.
  - `formatRemaining under a minute`: → `"còn <1p"`.
  - `connectionLabel prettifies opencode model`: `("opencode_local","opencode-go/glm-5.3")` → `"OpenCode Go · GLM 5.3"`.
  - `swapDefault moves old default into the chosen slot`. Agent `claude_local` sonnet with fallbacks `[glm, deepseek]`;
    swapping on `deepseek` gives `adapterType "opencode_local"`, model `deepseek`, and fallbacks
    `[glm, claude-sonnet]`, with the carry keys still on the agent.
- [ ] **Step 2: Run them.**
  - Run: `cd ui && pnpm exec vitest run src/lib/model-fallback`.
  - Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them.** Expected: 4/4 PASS.
- [ ] **Step 5: Commit** with the message `feat(ui): model fallback data layer and copy`.

### Task 9: "Kết nối model" tab: header, stats, hub, timeline

**Files:**
- Create: `ui/src/components/model-fallback/ModelFallbackTab.tsx`, `ConnectionHub.tsx`, `ConnectionCard.tsx`,
  `FallbackTimeline.tsx`
- Modify: `ui/src/pages/agent-detail-navigation.ts`. Add `"connections"` to `AgentDetailView`, add the nav item
  `{ value: "connections", label: "Kết nối model" }` after `runtime`, and parse `"connections"`.
- Modify: `ui/src/pages/AgentDetail.tsx` at ~1105. Render `<ModelFallbackTab agent=… companyId=… />` when
  `activeView === "connections"`.
- Test: `ui/src/components/model-fallback/ModelFallbackTab.test.tsx`

**Interfaces:**
- Consumes: Task 8 API, keys, strings, `formatRemaining`, `connectionLabel`.
- Produces: `ModelFallbackTab({ agent, companyId }: { agent: Agent; companyId: string })`.

**Behaviour:**
- **Refresh.** The tab refetches every 15 s, and every 5 s while any connection is `inUse`.
- **Header chip** (spec rule 12). It shows the in-use connection whose latest run started most recently. When more
  than one connection is `inUse`, it adds `"+{n} kết nối khác"`. Test: `chip shows +1 when two connections are in use`.
- **Hub.**
  - The agent card is on the left. Connection cards are on the right, in chain order. An SVG layer draws one curve
    per card.
  - Line styles, using the token colors from `index.css`:
    - in use: thick and animated;
    - exhausted: dotted, in the warning tone;
    - idle: thin and muted.
  - Respect `prefers-reduced-motion`: no animation.
- **Phones.** Below `md`, the hub becomes a vertical list with no SVG.
- **Exhausted cards** show quota bars when `quotaWindows` is non-empty. Otherwise they show the reset only.

- [ ] **Step 1: Write the failing tests.** Mock `modelFallbackApi.agentView`.
  - `shows the in-use connection in the header chip`. With GLM in use, the chip text contains `"Đang chạy"` and
    `"GLM 5.3"`, and the `"Dự phòng 1"` tag is present.
  - `marks the exhausted default`. The default card shows `"Hết token · còn 5g 28p"`.
  - `lists timeline events newest first`.
  - `nav includes Kết nối model after Harness / Runtime`, in `agent-detail-navigation`.
- [ ] **Step 2: Run them.**
  - Run: `cd ui && pnpm exec vitest run src/components/model-fallback src/pages/agent-detail-navigation`.
  - Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them, then the gates.**
  - Run the tests. Expected: PASS.
  - Run `pnpm check:token-gates`. Expected: clean.
  - Run `cd ui && pnpm exec tsc --noEmit -p tsconfig.json`. Expected: no new errors outside the known storybook and
    generated-catalog ones.
- [ ] **Step 5: Commit** with the message `feat(ui): Kết nối model tab`.

### Task 10: Editing: edit, add, set default, reorder, settings

**Files:**
- Create: `ui/src/components/model-fallback/EditConnectionDialog.tsx`, `AddConnectionDialog.tsx`,
  `FallbackSettingsDialog.tsx`
- Modify: `ConnectionHub.tsx` and `ConnectionCard.tsx` (✎, ☆ and drag-and-drop)
- Test: `ui/src/components/model-fallback/editing.test.tsx`

**Interfaces:**
- Consumes:
  - Task 8 `swapDefault`;
  - `agentsApi.update` (PATCH);
  - `agentsApi.adapterModels(companyId, adapterType)` for the model lists;
  - `AiConnectionField` (`ui/src/components/ai-connections/AiConnectionField.tsx`) for "Tài khoản";
  - `agentsApi.testEnvironment(companyId, adapterType, ...)` for "Kiểm tra kết nối".

**Behaviour:**
- **Edit dialog.**
  - **The default connection.** The dialog edits the agent's own fields. It PATCHes `adapterType`, `adapterConfig` and
    `runtimeConfig.aiConnection`, so the Harness / Runtime tab shows the same values.
  - **A fallback.** The dialog edits that entry in `runtimeConfig.modelFallback.connections`.
  - **"Xoá kết nối"** is hidden for the default.
- **Add dialog.**
  - Type cards in this order: OpenCode Go (`opencode_local`, no binding); Tài khoản Claude khác (`claude_local`, an
    Anthropic binding, which must differ from the default's); Codex (`codex_local`); Endpoint tương thích Anthropic.
  - A new Claude connection copies the default's Claude-specific keys when the default is `claude_local`.
  - **Endpoint tương thích Anthropic:**
    - it is `claude_local` with `env.ANTHROPIC_BASE_URL` (plain text) and `env.ANTHROPIC_AUTH_TOKEN` as a secret
      reference, chosen from the company's secrets with the existing secret picker that "Secrets & variables" uses;
    - **ruling:** the builder may ship this type disabled, with the tag "Sắp có", if the secret-reference path does not
      fit within this task;
    - record which choice was made in the ledger.
- **Set default** (☆, or dragging a card to position 1). PATCH with `swapDefault(...)`.
- **Reorder** (drag in the hub, or the list in the settings dialog). PATCH with the reordered `connections`.
- **Settings dialog.** PATCH `enabled` and `noResetWaitMinutes`.
- **Every save** invalidates the agent detail query and `queryKeys.modelFallback.agent`. Errors show in the dialog.

- [ ] **Step 1: Write the failing tests.** Mock `agentsApi.update` and capture the bodies.
  - `editing the default model patches the agent's adapterConfig.model`: Sonnet → `"claude-opus-5-5"`.
  - `adding opencode appends a connection`: `connections.at(-1)` has `adapterType: "opencode_local"` and model
    `"opencode-go/deepseek-v4.1-flash"`.
  - `set default swaps configs`. The body equals the `swapDefault` output.
  - `delete is hidden for the default`.
  - `settings toggle patches enabled false`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them, then the gates.** Expected: tests PASS, and the token gates and tsc are clean as in Task 9.
- [ ] **Step 5: Commit** with the message `feat(ui): edit model fallback chain`.

### Task 11: Show the in-use connection elsewhere

**Files:**
- Modify: the agent page header, in `ui/src/pages/AgentDetail.tsx`: the harness line under the agent name, for example
  "✳ Claude Code".
- Modify: `ui/src/pages/office/useOfficeData.ts`, and where Office builds `modelBadgeFor(...)`.
- Test: extend `ui/src/pages/office/*.test.ts` or `ui/src/lib/office/*.test.ts`, plus one AgentDetail header test.

**Interfaces:**
- Consumes: `modelFallbackApi.companyActive` (Task 8).
- Produces:
  - When an agent appears in `companyActive` with `isFallback`, its header and its Office badge use that
    `adapterType`/`model`, plus the tag "Dự phòng".
  - Otherwise they are unchanged.

- [ ] **Step 1: Write the failing tests.**
  - `office badge shows fallback model when active`.
  - `agent header shows fallback harness with Dự phòng tag`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** Use one company-level query, refreshed every 15 s and shared by both places.
- [ ] **Step 4: Run them.** Expected: PASS. The full Office tests still pass.
- [ ] **Step 5: Commit** with the message `feat(ui): show in-use connection on agent header and Office`.

### Task 12: OpenCode usage-limit signal (investigate; spec §7)

**Files:**
- Read: `packages/adapters/opencode-local/src/server/*`, the installed `opencode` CLI (`opencode --help` and its
  error output), and the OpenCode Go docs.
- Possibly modify: the OpenCode adapter's result parsing, so that a recognised limit error returns
  `errorCode: "provider_quota"`.

- [ ] **Step 1: Look for the signal.** Find what OpenCode emits when the provider returns a usage-limit (HTTP 429/402)
  error in `--format json` mode: an event type, an error part, or an exit code.
  - Do not spend OpenCode Go quota on purpose.
  - Use the CLI source, release notes and existing run logs under `~/.paperclip/instances/default/data` only.
- [ ] **Step 2: If a signal exists.**
  - Write a failing parse test with that exact payload: `opencode limit error maps to provider_quota`.
  - Implement the mapping and make the test pass.
  - Commit with the message `feat(opencode): classify usage-limit errors as provider_quota`.
- [ ] **Step 3: If there is no signal.** Make no code change. Write a ledger note that says what was checked. The final
  report to the owner says that OpenCode → next connection cannot fire automatically yet, and asks whether they want a
  no-output watchdog (spec §7).

### Task 13: Verification, cut-over and QUA setup

- [ ] **Step 1: Full verification in the worktree.**
  - Run: `node scripts/typecheck-low-memory.mjs`, `pnpm test:run` and `pnpm build`, one at a time.
  - Expected: all pass.
  - The two known flakes may fail. They are `AgentToolsTab.test.tsx` "autosaves installed apps" and the server
    `chat-channels.integration` timeouts. If either fails, re-run that file alone 3× and record the result.
- [ ] **Step 2: Live check in the worktree instance.**
  1. Start the worktree's `pnpm dev` on its own port.
  2. Give a seeded agent a chain.
  3. Force an exhaustion row for its default account, using a direct SQL insert into the worktree DB only.
  4. Wake it on an issue.
  5. Confirm all of these:
     - the run is claimed with `opencode_local`;
     - the issue gets the switch comment;
     - the tab shows the in-use chip and the hub;
     - after the issue is set to done and the row is moved into the past, the next run returns to the default.
  6. Take Playwright screenshots of `/…/agents/<agent>/connections` in light and dark mode.
- [ ] **Step 3: Stop for the owner.** Report the results and the cut-over plan. Cut-over changes the live instance,
  which is a shared side effect, so wait for the owner's go-ahead.
- [ ] **Step 4: Cut-over, after approval.**
  1. Back up the live database with `pnpm paperclipai db:backup`, run in `~/paperclip`.
  2. Wait until no QUA run is `running`. Check with `GET /api/companies/<QUA>/heartbeat-runs?limit=20`.
  3. Merge `feat/model-fallback` into local `master` in `~/paperclip`. This is a fast-forward or a merge commit.
  4. The live dev server reloads and applies the migration. Confirm that `GET /api/health` reports `"status":"ok"`.
  5. Remove the worktree with `git worktree remove ../paperclip-fallback`. Do this only if it has no uncommitted
     files.
- [ ] **Step 5: Apply the §3.3 chains.**
  - Use a scratch script that PATCHes each of the 10 agents with `runtimeConfig.modelFallback`.
  - Resolve "the other Claude account":
    - agents on `938f374a` get `b3dd465b`, and the reverse;
    - for `responsible_user` agents, first resolve the owner's Anthropic default through `GET …/ai-connections`.
  - New Claude connections copy the agent's current Claude `adapterConfig`, minus the carry keys.
  - Confirm each agent's `GET /api/agents/:id/model-fallback`.
- [ ] **Step 6: Update the feature map.** Only if the repo's map rules require it for a new agent tab: follow
  `maps/README.md` and run `node scripts/check-maps.mjs`.
