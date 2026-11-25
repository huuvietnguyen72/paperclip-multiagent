import {
  TEAM_FEED_NOTE_MAX_CHARS,
  TEAM_FEED_TOP_FILES,
  type TeamFeedChanges,
  type TeamFeedFileChange,
  type TeamFeedItem,
} from "@paperclipai/shared";

/** Pure pieces of the team feed: what a status row means and which code changes belong to it. */

export interface FeedRun {
  runId: string;
  startedAt: Date;
  /** When the run ended; null while it is still running. */
  endedAt: Date | null;
  /** Capture status: captured, pending, no_changes, skipped, ... */
  status: string;
  files: TeamFeedFileChange[];
}

export interface FeedStatusEvent {
  id: string;
  at: Date;
  to: string;
}

type Record_ = Record<string, unknown>;
const asRecord = (value: unknown): Record_ | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record_) : null;
const asString = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);

export function readStatusChange(details: unknown): { from: string | null; to: string } | null {
  const record = asRecord(details);
  const to = asString(record?.status);
  if (!record || !to) return null;
  const from = asString(asRecord(asRecord(record.changes)?.status)?.from)
    ?? asString(asRecord(record._previous)?.status)
    ?? asString(record.previousStatus);
  if (from === to) return null;
  return { from, to };
}

export function actorFor(
  row: { actorType: string; agentId: string | null },
  agentNames: Map<string, string>,
): TeamFeedItem["actor"] {
  if (row.actorType === "agent") {
    return { kind: "agent", agentId: row.agentId, name: (row.agentId && agentNames.get(row.agentId)) || "Agent" };
  }
  if (row.actorType === "user") return { kind: "board", agentId: null, name: "Board" };
  return { kind: "system", agentId: null, name: "System" };
}

const PLAIN_SOURCES = new Set(["comment", "update"]);

export function reasonFor(details: unknown): string | null {
  const source = asString(asRecord(details)?.source);
  return source && !PLAIN_SOURCES.has(source) ? source : null;
}

export function noteExcerpt(markdown: string): string {
  const text = markdown
    .replace(/^\s*(```|~~~).*$/gm, " ") // code fence lines (keep the code itself)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1") // images
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // links
    .replace(/`([^`]*)`/g, "$1") // inline code
    .replace(/^\s{0,3}#{1,6}\s+/gm, "") // headings
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, "") // list markers
    .replace(/^\s*>\s?/gm, "") // quotes
    .replace(/(\*\*|__|\*|_|~~)(?=\S)([\s\S]*?\S)\1/g, "$2") // emphasis
    .replace(/\s+/g, " ")
    .trim();
  return text.length > TEAM_FEED_NOTE_MAX_CHARS ? `${text.slice(0, TEAM_FEED_NOTE_MAX_CHARS)}…` : text;
}

/**
 * Which runs each status event shows. A change to done shows every run that started by then (the whole task).
 * Any other change shows the runs attributed to it: a run belongs to the latest event at or before the run's end
 * (agents change status during their run, so the run usually ends after the event). Runs that ended before the
 * first event go to the first event; runs still going go to the latest event.
 */
export function attributeRuns(events: FeedStatusEvent[], runs: FeedRun[]): Map<string, FeedRun[]> {
  const ordered = [...events].sort((a, b) => a.at.getTime() - b.at.getTime());
  const sortedRuns = [...runs].sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
  const shown = new Map<string, FeedRun[]>(ordered.map((event) => [event.id, []]));
  if (ordered.length === 0) return shown;

  const owner = (run: FeedRun): FeedStatusEvent => {
    if (!run.endedAt) return ordered[ordered.length - 1]!;
    let match = ordered[0]!;
    for (const event of ordered) {
      if (event.at.getTime() <= run.endedAt.getTime()) match = event;
      else break;
    }
    return match;
  };

  for (const event of ordered) {
    if (event.to === "done") {
      shown.set(event.id, sortedRuns.filter((run) => run.startedAt.getTime() <= event.at.getTime()));
    }
  }
  for (const run of sortedRuns) {
    const event = owner(run);
    if (event.to !== "done") shown.get(event.id)!.push(run);
  }
  return shown;
}

export function summarizeChanges(runs: FeedRun[]): TeamFeedChanges | null {
  if (runs.length === 0) return null;
  const byPath = new Map<string, TeamFeedFileChange>();
  for (const run of runs) {
    for (const file of run.files) {
      const current = byPath.get(file.path) ?? { path: file.path, additions: 0, deletions: 0, binary: false };
      current.additions += file.additions;
      current.deletions += file.deletions;
      current.binary = current.binary || file.binary;
      byPath.set(file.path, current);
    }
  }
  const all = [...byPath.values()];
  const files = [...all]
    .sort((a, b) => (b.additions + b.deletions) - (a.additions + a.deletions) || a.path.localeCompare(b.path))
    .slice(0, TEAM_FEED_TOP_FILES);
  return {
    totalFiles: all.length,
    additions: all.reduce((sum, file) => sum + file.additions, 0),
    deletions: all.reduce((sum, file) => sum + file.deletions, 0),
    pending: runs.some((run) => run.status === "pending"),
    files,
  };
}
