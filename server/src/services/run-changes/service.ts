import { existsSync } from "node:fs";
import {
  agents, heartbeatRunChangeFiles, heartbeatRunChanges, heartbeatRuns, type Db,
} from "@paperclipai/db";
import type { IssueRunChangesEntry, RunChangeFilePatch, RunChangeStatus } from "@paperclipai/shared";
import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { logger } from "../../middleware/logger.js";
import { redactSensitiveText } from "../../redaction.js";
import { HEARTBEAT_RUN_TERMINAL_STATUSES } from "../heartbeat/recovery.js";
import { getRunLogStore, isRunLogStoreType } from "../run-log-store.js";
import { extractRunCommands } from "./commands.js";
import { captureSnapshot, diffSnapshots, type Snapshot } from "./git-snapshot.js";

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

function startSnapshotOf(row: RunChangeRow): Snapshot | null {
  return row.startTree ? { head: row.startHead, tree: row.startTree, branch: row.startBranch } : null;
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
  async function finalizeWith(row: RunChangeRow, end: Snapshot, extraOverlap: string[] = []) {
    const start = startSnapshotOf(row);
    if (!start || !row.cwd) return closeWithStatus(row.id, "failed", "missing_start_snapshot");
    const diff = await diffSnapshots(row.cwd, start, end, redactSensitiveText);
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
        endHead: end.head,
        endTree: end.tree,
        endBranch: end.branch,
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
    const end = await captureSnapshot(row.cwd);
    if (!end.ok) return closeWithStatus(row.id, end.reason === "not_git" ? "incomplete" : "failed", end.reason);
    await finalizeWith(row, end.snapshot);
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

    const snapshot = await captureSnapshot(input.executionWorkspace.cwd);
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
      if (stillRunning) overlapping.push(row.runId);
      await finalizeWith(row, snapshot.snapshot, stillRunning ? [input.run.id] : []);
    }

    await insert({
      status: "pending",
      startHead: snapshot.snapshot.head,
      startTree: snapshot.snapshot.tree,
      startBranch: snapshot.snapshot.branch,
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
      branchChanged: change.endBranch !== null && change.startBranch !== change.endBranch,
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
