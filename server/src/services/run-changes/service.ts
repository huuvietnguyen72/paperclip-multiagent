import { existsSync } from "node:fs";
import path from "node:path";
import {
  agents, heartbeatRunChangeFiles, heartbeatRunChanges, heartbeatRuns, type Db,
} from "@paperclipai/db";
import type { IssueRunChangesEntry, RunChangeFile, RunChangeFilePatch, RunChangeStatus } from "@paperclipai/shared";
import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { logger } from "../../middleware/logger.js";
import { redactSensitiveText } from "../../redaction.js";
import { HEARTBEAT_RUN_TERMINAL_STATUSES } from "../heartbeat/recovery.js";
import { getRunLogStore, isRunLogStoreType } from "../run-log-store.js";
import { extractRunCommands } from "./commands.js";
import { captureWorkspaceSnapshots, diffSnapshots, type Snapshot } from "./git-snapshot.js";

type RunChangeRow = typeof heartbeatRunChanges.$inferSelect;
type RunRow = typeof heartbeatRuns.$inferSelect;

const TERMINAL = new Set<string>(HEARTBEAT_RUN_TERMINAL_STATUSES);
const MAX_LOG_BYTES = 32 * 1024 * 1024;

export interface RecordRunStartInput {
  run: { id: string; companyId: string; agentId: string; startedAt: Date | null };
  executionWorkspace: { cwd: string };
  persistedExecutionWorkspace: { id: string; providerType: string } | null;
  executionTarget: { kind: string } | null;
  issueId: string | null;
}

export interface RunChangesDependencies {
  readRunLog?: (run: Pick<RunRow, "logStore" | "logRef">) => Promise<string>;
}

async function readRunLogFromStore(run: Pick<RunRow, "logStore" | "logRef">): Promise<string> {
  if (!run.logRef || !isRunLogStoreType(run.logStore)) return "";
  const store = getRunLogStore();
  let content = "";
  let offset = 0;
  while (content.length < MAX_LOG_BYTES) {
    const result = await store.read({ store: run.logStore, logRef: run.logRef }, { offset, limitBytes: 4 * 1024 * 1024 });
    content += result.content;
    if (result.nextOffset === undefined || result.nextOffset === offset || !result.content) break;
    offset = result.nextOffset;
  }
  return content;
}

type Repos = Record<string, Snapshot>;

function startReposOf(row: RunChangeRow): Repos {
  if (Object.keys(row.startSnapshots).length > 0) return row.startSnapshots;
  return row.startTree ? { ".": { head: row.startHead, tree: row.startTree, branch: row.startBranch } } : {};
}

function newReposOf(row: RunChangeRow): string[] {
  if (Object.keys(row.endSnapshots).length === 0) return [];
  const start = startReposOf(row);
  return Object.keys(row.endSnapshots).filter((key) => !(key in start)).sort();
}

function branchChangedOf(row: RunChangeRow): boolean {
  const start = startReposOf(row);
  const end = Object.keys(row.endSnapshots).length > 0 ? row.endSnapshots
    : row.endTree ? { ".": { head: row.endHead, tree: row.endTree, branch: row.endBranch } } : {};
  return Object.entries(end).some(([key, snapshot]) => key in start && snapshot.branch !== null && start[key]!.branch !== snapshot.branch);
}

/** Diffs every repository present at both ends; nested repositories get their directory as path prefix. */
async function diffRepos(cwd: string, start: Repos, end: Repos) {
  const files: RunChangeFile[] = [];
  const patches = new Map<string, string | null>();
  let additions = 0;
  let deletions = 0;
  for (const key of Object.keys(end).sort()) {
    const before = start[key];
    if (!before) continue;
    const prefix = key === "." ? "" : `${key}/`;
    const diff = await diffSnapshots(key === "." ? cwd : path.join(cwd, key), before, end[key]!, redactSensitiveText);
    additions += diff.additions;
    deletions += diff.deletions;
    for (const file of diff.files) files.push({ ...file, path: prefix + file.path, oldPath: file.oldPath ? prefix + file.oldPath : null });
    for (const [filePath, patch] of diff.patches) patches.set(prefix + filePath, patch);
  }
  return { files, patches, additions, deletions };
}

export function createRunChangesService(db: Db, deps: RunChangesDependencies = {}) {
  const readRunLog = deps.readRunLog ?? readRunLogFromStore;

  async function loadRun(runId: string): Promise<RunRow | undefined> {
    return db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).then((rows) => rows[0]);
  }

  async function closeWithStatus(rowId: string, status: RunChangeStatus, reason: string | null) {
    await db.update(heartbeatRunChanges)
      .set({ status, reason, finalizedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(heartbeatRunChanges.id, rowId), eq(heartbeatRunChanges.status, "pending")));
  }

  /** Diff a pending row against an end snapshot and persist it. Only the first writer wins. */
  async function finalizeWith(row: RunChangeRow, end: Repos, extraOverlap: string[] = []) {
    const start = startReposOf(row);
    if (Object.keys(start).length === 0 || !row.cwd) return closeWithStatus(row.id, "failed", "missing_start_snapshot");
    const diff = await diffRepos(row.cwd, start, end);
    const single = end["."];
    const run = await loadRun(row.runId);
    let commands: ReturnType<typeof extractRunCommands> = [];
    if (run) {
      try {
        commands = extractRunCommands(await readRunLog(run), redactSensitiveText);
      } catch (error) {
        logger.warn({ err: error, runId: row.runId }, "run changes: could not read run log for commands");
      }
    }
    const overlap = [...new Set([...row.overlappingRunIds, ...extraOverlap])];
    await db.transaction(async (tx) => {
      const updated = await tx.update(heartbeatRunChanges).set({
        status: diff.files.length > 0 ? "captured" : "no_changes",
        reason: null,
        endHead: single?.head ?? null,
        endTree: single?.tree ?? null,
        endBranch: single?.branch ?? null,
        endSnapshots: end,
        additions: diff.additions,
        deletions: diff.deletions,
        files: diff.files,
        commands,
        overlappingRunIds: overlap,
        finalizedAt: new Date(),
        updatedAt: new Date(),
      }).where(and(eq(heartbeatRunChanges.id, row.id), eq(heartbeatRunChanges.status, "pending"))).returning({ id: heartbeatRunChanges.id });
      if (updated.length === 0) return;
      const values = [...diff.patches.entries()].map(([path, patch]) => ({ runChangeId: row.id, path, patch }));
      if (values.length > 0) await tx.insert(heartbeatRunChangeFiles).values(values).onConflictDoNothing();
    });
  }

  async function finalizeRow(row: RunChangeRow) {
    if (row.status !== "pending") return;
    if (!row.cwd || !existsSync(row.cwd)) return closeWithStatus(row.id, "incomplete", "workspace_missing");
    const end = await captureWorkspaceSnapshots(row.cwd);
    if (!end.ok) return closeWithStatus(row.id, end.reason === "not_git" ? "incomplete" : "failed", end.reason);
    await finalizeWith(row, end.repos);
  }

  async function recordRunStart(input: RecordRunStartInput): Promise<void> {
    const base = {
      companyId: input.run.companyId,
      runId: input.run.id,
      issueId: input.issueId,
      agentId: input.run.agentId,
      executionWorkspaceId: input.persistedExecutionWorkspace?.id ?? null,
      cwd: input.executionWorkspace.cwd,
      startedAt: input.run.startedAt ?? new Date(),
    };
    const insert = (values: Partial<typeof heartbeatRunChanges.$inferInsert> & { status: RunChangeStatus }) =>
      db.insert(heartbeatRunChanges).values({ ...base, ...values }).onConflictDoNothing();

    const remote = input.executionTarget?.kind === "remote"
      || (input.persistedExecutionWorkspace !== null && input.persistedExecutionWorkspace.providerType !== "local_fs");
    if (remote) return void (await insert({ status: "skipped", reason: "remote" }));

    const snapshot = await captureWorkspaceSnapshots(input.executionWorkspace.cwd);
    if (!snapshot.ok) {
      const status: RunChangeStatus = snapshot.reason === "error" ? "failed" : "skipped";
      return void (await insert({ status, reason: snapshot.reason }));
    }

    // Close captures left open on the same workspace: this run's start is their end.
    // Same directory is what makes this run's snapshot a valid end for them.
    const sameWorkspace = and(
      eq(heartbeatRunChanges.cwd, base.cwd),
      base.executionWorkspaceId ? eq(heartbeatRunChanges.executionWorkspaceId, base.executionWorkspaceId) : undefined,
    );
    const open = await db.select().from(heartbeatRunChanges).where(and(
      sameWorkspace, eq(heartbeatRunChanges.status, "pending"), ne(heartbeatRunChanges.runId, input.run.id),
    ));
    const overlapping: string[] = [];
    for (const row of open) {
      const run = await loadRun(row.runId);
      const stillRunning = run !== undefined && !TERMINAL.has(run.status);
      if (stillRunning) {
        // The other run is still working: keep its capture open (its own end is taken when it
        // finishes) and mark both runs as overlapping, since their diffs may include each other.
        overlapping.push(row.runId);
        await db.update(heartbeatRunChanges)
          .set({ overlappingRunIds: [...new Set([...row.overlappingRunIds, input.run.id])], updatedAt: new Date() })
          .where(eq(heartbeatRunChanges.id, row.id));
      } else {
        // A finished run whose capture was never closed: this run's start is its end.
        await finalizeWith(row, snapshot.repos);
      }
    }

    const single = snapshot.repos["."];
    await insert({
      status: "pending",
      startHead: single?.head ?? null,
      startTree: single?.tree ?? null,
      startBranch: single?.branch ?? null,
      startSnapshots: snapshot.repos,
      overlappingRunIds: overlapping,
    });
  }

  async function finalizeRun(runId: string): Promise<void> {
    const row = await db.select().from(heartbeatRunChanges).where(eq(heartbeatRunChanges.runId, runId)).then((rows) => rows[0]);
    if (row) await finalizeRow(row);
  }

  async function pendingTerminalRows(): Promise<RunChangeRow[]> {
    return db.select({ change: heartbeatRunChanges }).from(heartbeatRunChanges)
      .innerJoin(heartbeatRuns, eq(heartbeatRuns.id, heartbeatRunChanges.runId))
      .where(and(eq(heartbeatRunChanges.status, "pending"), inArray(heartbeatRuns.status, [...TERMINAL])))
      .then((rows) => rows.map((row) => row.change));
  }

  async function finalizePending(): Promise<number> {
    const rows = await pendingTerminalRows();
    for (const row of rows) {
      try {
        await finalizeRow(row);
      } catch (error) {
        logger.warn({ err: error, runId: row.runId }, "run changes: finalize failed");
        await closeWithStatus(row.id, "failed", "finalize_error");
      }
    }
    return rows.length;
  }

  async function hasPendingWork(): Promise<boolean> {
    return (await pendingTerminalRows()).length > 0;
  }

  async function listForIssue(companyId: string, issueId: string): Promise<IssueRunChangesEntry[]> {
    const rows = await db.select({ change: heartbeatRunChanges, run: heartbeatRuns, agentName: agents.name })
      .from(heartbeatRunChanges)
      .innerJoin(heartbeatRuns, eq(heartbeatRuns.id, heartbeatRunChanges.runId))
      .innerJoin(agents, eq(agents.id, heartbeatRunChanges.agentId))
      .where(and(eq(heartbeatRunChanges.companyId, companyId), eq(heartbeatRunChanges.issueId, issueId)))
      .orderBy(desc(heartbeatRunChanges.startedAt), desc(heartbeatRunChanges.createdAt));
    return rows.map(({ change, run, agentName }) => ({
      runId: change.runId,
      agentId: change.agentId,
      agentName,
      runStatus: run.status,
      startedAt: (run.startedAt ?? change.startedAt)?.toISOString() ?? null,
      finishedAt: run.finishedAt?.toISOString() ?? null,
      status: change.status as RunChangeStatus,
      reason: change.reason,
      additions: change.additions,
      deletions: change.deletions,
      files: change.files,
      commands: change.commands,
      overlappingRunIds: change.overlappingRunIds,
      branchChanged: branchChangedOf(change),
      newRepos: newReposOf(change),
    }));
  }

  async function getFilePatch(companyId: string, runId: string, path: string, issueId?: string): Promise<RunChangeFilePatch | null> {
    const change = await db.select().from(heartbeatRunChanges).where(and(
      eq(heartbeatRunChanges.companyId, companyId),
      eq(heartbeatRunChanges.runId, runId),
      issueId ? eq(heartbeatRunChanges.issueId, issueId) : undefined,
    )).then((rows) => rows[0]);
    const file = change?.files.find((entry) => entry.path === path);
    if (!change || !file) return null;
    const stored = await db.select({ patch: heartbeatRunChangeFiles.patch }).from(heartbeatRunChangeFiles)
      .where(and(eq(heartbeatRunChangeFiles.runChangeId, change.id), eq(heartbeatRunChangeFiles.path, path)))
      .then((rows) => rows[0]);
    return { runId, path, patch: stored?.patch ?? null, binary: file.binary, truncated: file.truncated };
  }

  return { recordRunStart, finalizeRun, finalizePending, hasPendingWork, listForIssue, getFilePatch };
}

export type RunChangesService = ReturnType<typeof createRunChangesService>;
