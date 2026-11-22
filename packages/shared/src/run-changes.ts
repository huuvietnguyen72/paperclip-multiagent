/**
 * Per-run code changes ("Changes" panel): what files an agent run changed and
 * which commands it ran. Captured from git snapshots taken at the start and
 * end of each run that works in a local git workspace.
 */

export type RunChangeStatus = "pending" | "captured" | "no_changes" | "skipped" | "incomplete" | "failed";

export type RunChangeFileStatus = "added" | "modified" | "deleted" | "renamed";

export interface RunChangeFile {
  path: string;
  oldPath: string | null;
  status: RunChangeFileStatus;
  additions: number;
  deletions: number;
  binary: boolean;
  truncated: boolean;
  collapsedByDefault: boolean;
}

export interface RunChangeSnapshot {
  head: string | null;
  tree: string;
  branch: string | null;
}

export interface RunChangeCommand {
  ts: string | null;
  tool: string;
  text: string;
}

export interface IssueRunChangesEntry {
  runId: string;
  agentId: string;
  agentName: string;
  runStatus: string;
  startedAt: string | null;
  finishedAt: string | null;
  status: RunChangeStatus;
  reason: string | null;
  additions: number;
  deletions: number;
  files: RunChangeFile[];
  commands: RunChangeCommand[];
  overlappingRunIds: string[];
  branchChanged: boolean;
  /** Repositories that appeared during the run; their initial checkout is not listed as changes. */
  newRepos: string[];
}

export interface RunChangeFilePatch {
  runId: string;
  path: string;
  patch: string | null;
  binary: boolean;
  truncated: boolean;
}

export const RUN_CHANGES_LIMITS = {
  fileLines: 2000,
  fileBytes: 262144,
  files: 300,
  totalBytes: 4194304,
  commands: 200,
  commandChars: 500,
  snapshotTimeoutMs: 20000,
} as const;
