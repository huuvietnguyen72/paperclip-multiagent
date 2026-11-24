/**
 * Project "Code" tab: a read-only view of a local project workspace that the server keeps
 * fast-forwarded. A workspace takes part only when its metadata has `codeView.enabled === true`.
 */

export const PROJECT_CODE_VIEW_RESULTS = [
  "updated",
  "up_to_date",
  "skipped_dirty",
  "skipped_detached",
  "diverged",
  "error",
] as const;
export type ProjectCodeViewResult = (typeof PROJECT_CODE_VIEW_RESULTS)[number];

export type ProjectCodeRefreshReason = "open" | "manual" | "task_done";

export interface ProjectCodeViewMetadata {
  enabled: boolean;
  lastUpdatedAt: string | null;
  lastResult: ProjectCodeViewResult | null;
  lastError: string | null;
  head: string | null;
}

export interface ProjectCodeViewStatus {
  projectId: string;
  workspaceId: string;
  workspaceName: string;
  branch: string | null;
  /** Short commit sha of the local copy. */
  head: string | null;
  subject: string | null;
  lastUpdatedAt: string | null;
  lastResult: ProjectCodeViewResult | null;
  lastError: string | null;
  refreshing: boolean;
}

export const PROJECT_CODE_VIEW_OPEN_THROTTLE_MS = 60_000;
export const PROJECT_CODE_VIEW_GIT_TIMEOUT_MS = 60_000;

const stringOrNull = (value: unknown) => (typeof value === "string" ? value : null);

export function readProjectCodeViewMetadata(metadata: unknown): ProjectCodeViewMetadata | null {
  if (!metadata || typeof metadata !== "object") return null;
  const codeView = (metadata as Record<string, unknown>).codeView;
  if (!codeView || typeof codeView !== "object") return null;
  const raw = codeView as Record<string, unknown>;
  if (raw.enabled !== true) return null;
  const lastResult = (PROJECT_CODE_VIEW_RESULTS as readonly string[]).includes(raw.lastResult as string)
    ? (raw.lastResult as ProjectCodeViewResult)
    : null;
  return {
    enabled: true,
    lastUpdatedAt: stringOrNull(raw.lastUpdatedAt),
    lastResult,
    lastError: stringOrNull(raw.lastError),
    head: stringOrNull(raw.head),
  };
}
