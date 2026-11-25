/**
 * Team feed: a read-only, chat-like list of task status changes with the agent's note and the files the
 * work changed. Derived from existing data (activity log, comments, run captures); nothing is written.
 */

export interface TeamFeedFileChange {
  path: string;
  additions: number;
  deletions: number;
  binary: boolean;
}

export interface TeamFeedChanges {
  totalFiles: number;
  additions: number;
  deletions: number;
  /** A counted run is still recording its changes. */
  pending: boolean;
  files: TeamFeedFileChange[];
}

export interface TeamFeedItem {
  /** activity_log id */
  id: string;
  at: string;
  actor: { kind: "agent" | "board" | "system"; agentId: string | null; name: string };
  reason: string | null;
  issue: { id: string; identifier: string | null; title: string };
  fromStatus: string | null;
  toStatus: string;
  note: string | null;
  changes: TeamFeedChanges | null;
}

export interface TeamFeedResponse {
  items: TeamFeedItem[];
  nextCursor: string | null;
}

export const TEAM_FEED_DEFAULT_LIMIT = 30;
export const TEAM_FEED_MAX_LIMIT = 100;
export const TEAM_FEED_TOP_FILES = 5;
export const TEAM_FEED_NOTE_MAX_CHARS = 280;
export const TEAM_FEED_PENDING_POLL_MS = 15_000;
