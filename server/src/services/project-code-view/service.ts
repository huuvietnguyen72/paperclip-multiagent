import { projectWorkspaces, type Db } from "@paperclipai/db";
import {
  PROJECT_CODE_VIEW_OPEN_THROTTLE_MS,
  readProjectCodeViewMetadata,
  type ProjectCodeRefreshReason,
  type ProjectCodeViewMetadata,
  type ProjectCodeViewStatus,
} from "@paperclipai/shared";
import { and, asc, eq } from "drizzle-orm";
import { notFound } from "../../errors.js";
import { redactSensitiveText } from "../../redaction.js";
import { logActivity } from "../activity-log.js";
import { readCloneHead, refreshClone } from "./git.js";

/**
 * Project "Code" tab: which local workspaces take part (opt-in via metadata.codeView.enabled),
 * their current head, and keeping them fast-forwarded. Agents are never involved.
 */

type WorkspaceRow = typeof projectWorkspaces.$inferSelect;

export interface ProjectCodeViewDeps {
  git?: { readCloneHead: typeof readCloneHead; refreshClone: typeof refreshClone };
  now?: () => Date;
}

export interface ProjectCodeRefreshInput {
  companyId: string;
  projectId: string;
  workspaceId: string;
  reason: ProjectCodeRefreshReason;
  actor?: { actorType: "user" | "agent" | "system"; actorId: string };
}

const MAX_ERROR_CHARS = 500;

function enabledWorkspace(row: WorkspaceRow | undefined): { row: WorkspaceRow; codeView: ProjectCodeViewMetadata } | null {
  if (!row || !row.cwd?.trim()) return null;
  const codeView = readProjectCodeViewMetadata(row.metadata);
  return codeView ? { row, codeView } : null;
}

export function createProjectCodeViewService(db: Db, deps: ProjectCodeViewDeps = {}) {
  const git = deps.git ?? { readCloneHead, refreshClone };
  const now = deps.now ?? (() => new Date());
  const inFlight = new Map<string, Promise<ProjectCodeViewStatus>>();

  async function loadWorkspace(companyId: string, projectId: string, workspaceId: string) {
    const [row] = await db.select().from(projectWorkspaces).where(and(
      eq(projectWorkspaces.id, workspaceId),
      eq(projectWorkspaces.companyId, companyId),
      eq(projectWorkspaces.projectId, projectId),
    ));
    return enabledWorkspace(row);
  }

  async function toStatus(row: WorkspaceRow, codeView: ProjectCodeViewMetadata): Promise<ProjectCodeViewStatus> {
    const head = await git.readCloneHead(row.cwd!);
    return {
      projectId: row.projectId,
      workspaceId: row.id,
      workspaceName: row.name,
      branch: head.branch,
      head: head.head,
      subject: head.subject,
      lastUpdatedAt: codeView.lastUpdatedAt,
      lastResult: codeView.lastResult,
      lastError: codeView.lastError,
      refreshing: inFlight.has(row.id),
    };
  }

  async function listStatuses(companyId: string, projectId: string): Promise<ProjectCodeViewStatus[]> {
    const rows = await db.select().from(projectWorkspaces).where(and(
      eq(projectWorkspaces.companyId, companyId),
      eq(projectWorkspaces.projectId, projectId),
    )).orderBy(asc(projectWorkspaces.createdAt), asc(projectWorkspaces.id));
    const enabled = rows.map(enabledWorkspace).filter((entry): entry is NonNullable<typeof entry> => entry !== null);
    return Promise.all(enabled.map(({ row, codeView }) => toStatus(row, codeView)));
  }

  async function getEnabledWorkspace(companyId: string, projectId: string, workspaceId: string): Promise<WorkspaceRow | null> {
    return (await loadWorkspace(companyId, projectId, workspaceId))?.row ?? null;
  }

  async function runRefresh(input: ProjectCodeRefreshInput, row: WorkspaceRow, codeView: ProjectCodeViewMetadata) {
    const outcome = await git.refreshClone(row.cwd!);
    const error = outcome.error ? redactSensitiveText(outcome.error).slice(0, MAX_ERROR_CHARS) : null;
    const next: ProjectCodeViewMetadata = {
      enabled: true,
      lastUpdatedAt: now().toISOString(),
      lastResult: outcome.result,
      lastError: error,
      head: outcome.after ? outcome.after.slice(0, 7) : codeView.head,
    };
    // Re-read so a concurrent metadata edit (e.g. renaming keys) is not lost.
    const [fresh] = await db.select({ metadata: projectWorkspaces.metadata }).from(projectWorkspaces)
      .where(eq(projectWorkspaces.id, row.id));
    const metadata = { ...((fresh?.metadata as Record<string, unknown> | null) ?? {}), codeView: next };
    await db.update(projectWorkspaces).set({ metadata, updatedAt: now() }).where(eq(projectWorkspaces.id, row.id));

    const moved = outcome.before !== outcome.after;
    if (input.reason === "manual" || moved) {
      await logActivity(db, {
        companyId: input.companyId,
        actorType: input.actor?.actorType ?? "system",
        actorId: input.actor?.actorId ?? "project-code-view",
        action: "project.code_view_refreshed",
        entityType: "project",
        entityId: input.projectId,
        details: {
          workspaceId: row.id,
          reason: input.reason,
          result: outcome.result,
          before: outcome.before?.slice(0, 7) ?? null,
          after: outcome.after?.slice(0, 7) ?? null,
        },
      });
    }
    return { row: { ...row, metadata }, codeView: next };
  }

  async function refresh(input: ProjectCodeRefreshInput): Promise<ProjectCodeViewStatus> {
    const loaded = await loadWorkspace(input.companyId, input.projectId, input.workspaceId);
    if (!loaded) throw notFound("Project code view not found");
    const running = inFlight.get(loaded.row.id);
    if (running) return running;

    const last = loaded.codeView.lastUpdatedAt ? Date.parse(loaded.codeView.lastUpdatedAt) : NaN;
    if (input.reason === "open" && Number.isFinite(last) && now().getTime() - last < PROJECT_CODE_VIEW_OPEN_THROTTLE_MS) {
      return toStatus(loaded.row, loaded.codeView);
    }

    const statusPromise = runRefresh(input, loaded.row, loaded.codeView).then(async ({ row, codeView }) => {
      inFlight.delete(loaded.row.id);
      return toStatus(row, codeView);
    }, (error) => {
      inFlight.delete(loaded.row.id);
      throw error;
    });
    inFlight.set(loaded.row.id, statusPromise);
    return statusPromise;
  }

  async function refreshProject(companyId: string, projectId: string, reason: ProjectCodeRefreshReason): Promise<void> {
    const rows = await db.select().from(projectWorkspaces).where(and(
      eq(projectWorkspaces.companyId, companyId),
      eq(projectWorkspaces.projectId, projectId),
    ));
    for (const entry of rows.map(enabledWorkspace)) {
      if (!entry) continue;
      await refresh({ companyId, projectId, workspaceId: entry.row.id, reason });
    }
  }

  return { listStatuses, getEnabledWorkspace, refresh, refreshProject };
}

export type ProjectCodeViewService = ReturnType<typeof createProjectCodeViewService>;
