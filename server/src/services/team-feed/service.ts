import {
  activityLog, agents, heartbeatRunChanges, heartbeatRuns, issueComments, issues, type Db,
} from "@paperclipai/db";
import {
  TEAM_FEED_DEFAULT_LIMIT,
  TEAM_FEED_MAX_LIMIT,
  type TeamFeedItem,
  type TeamFeedResponse,
} from "@paperclipai/shared";
import { and, asc, desc, eq, inArray, isNotNull, isNull, lte, sql, type SQL } from "drizzle-orm";
import { badRequest } from "../../errors.js";
import {
  actorFor, attributeRuns, noteExcerpt, readStatusChange, reasonFor, summarizeChanges,
  type FeedRun, type FeedStatusEvent,
} from "./derive.js";

/**
 * Team feed read model: task status changes from the activity log, with the agent's note and the files the
 * work changed. Batched queries per page; nothing is written.
 */

const NOTE_GRACE_MS = 5_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Postgres timestamptz text, kept verbatim so the cursor keeps microsecond precision.
const PG_TIMESTAMP = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?([+-]\d{2}(:?\d{2})?|Z)?$/;

export interface TeamFeedCursor {
  /** Postgres timestamptz text of the last row shown. */
  at: string;
  id: string;
}

export function parseTeamFeedCursor(value: unknown): TeamFeedCursor | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw badRequest("Invalid team feed cursor");
  const split = value.lastIndexOf("|");
  const at = value.slice(0, split);
  const id = value.slice(split + 1);
  if (split <= 0 || !PG_TIMESTAMP.test(at) || !UUID.test(id)) throw badRequest("Invalid team feed cursor");
  return { at, id };
}

function statusRowFilter(companyId: string): SQL {
  const details = activityLog.details;
  return and(
    eq(activityLog.companyId, companyId),
    eq(activityLog.entityType, "issue"),
    eq(activityLog.action, "issue.updated"),
    sql`(${details}->>'status') is not null`,
    sql`coalesce(${details}->'changes'->'status'->>'from', ${details}->'_previous'->>'status', ${details}->>'previousStatus')
      is distinct from (${details}->>'status')`,
  )!;
}

export function createTeamFeedService(db: Db) {
  async function list(input: {
    companyId: string;
    readCondition: SQL<boolean>;
    before?: string | null;
    limit?: number;
  }): Promise<TeamFeedResponse> {
    const limit = Math.min(TEAM_FEED_MAX_LIMIT, Math.max(1, Math.floor(input.limit ?? TEAM_FEED_DEFAULT_LIMIT)));
    const cursor = parseTeamFeedCursor(input.before);

    const rows = await db.select({
      id: activityLog.id,
      createdAt: activityLog.createdAt,
      createdAtText: sql<string>`${activityLog.createdAt}::text`,
      actorType: activityLog.actorType,
      agentId: activityLog.agentId,
      details: activityLog.details,
      issueId: issues.id,
      identifier: issues.identifier,
      title: issues.title,
    }).from(activityLog)
      .innerJoin(issues, sql`${issues.id}::text = ${activityLog.entityId}`)
      .where(and(
        statusRowFilter(input.companyId),
        eq(issues.companyId, input.companyId),
        input.readCondition,
        cursor ? sql`(${activityLog.createdAt}, ${activityLog.id}) < (${cursor.at}::timestamptz, ${cursor.id}::uuid)` : undefined,
      ))
      .orderBy(desc(activityLog.createdAt), desc(activityLog.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit).flatMap((row) => {
      const change = readStatusChange(row.details);
      return change ? [{ ...row, change }] : [];
    });
    if (page.length === 0) return { items: [], nextCursor: null };

    const issueIds = [...new Set(page.map((row) => row.issueId))];
    const maxAt = new Date(Math.max(...page.map((row) => row.createdAt.getTime())) + NOTE_GRACE_MS);

    const [eventRows, agentRows, commentRows, runRows] = await Promise.all([
      db.select({ id: activityLog.id, at: activityLog.createdAt, entityId: activityLog.entityId, details: activityLog.details })
        .from(activityLog)
        .where(and(statusRowFilter(input.companyId), inArray(activityLog.entityId, issueIds)))
        .orderBy(asc(activityLog.createdAt), asc(activityLog.id)),
      (() => {
        const agentIds = [...new Set(page.map((row) => row.agentId).filter((id): id is string => Boolean(id)))];
        return agentIds.length === 0 ? Promise.resolve([]) : db.select({ id: agents.id, name: agents.name }).from(agents)
          .where(and(eq(agents.companyId, input.companyId), inArray(agents.id, agentIds)));
      })(),
      db.select({ issueId: issueComments.issueId, body: issueComments.body, createdAt: issueComments.createdAt })
        .from(issueComments)
        .where(and(
          eq(issueComments.companyId, input.companyId),
          inArray(issueComments.issueId, issueIds),
          isNotNull(issueComments.authorAgentId),
          isNull(issueComments.deletedAt),
          lte(issueComments.createdAt, maxAt),
        ))
        .orderBy(asc(issueComments.createdAt)),
      db.select({
        runId: heartbeatRunChanges.runId,
        issueId: heartbeatRunChanges.issueId,
        status: heartbeatRunChanges.status,
        files: heartbeatRunChanges.files,
        startedAt: heartbeatRunChanges.startedAt,
        finalizedAt: heartbeatRunChanges.finalizedAt,
        finishedAt: heartbeatRuns.finishedAt,
      }).from(heartbeatRunChanges)
        .leftJoin(heartbeatRuns, eq(heartbeatRuns.id, heartbeatRunChanges.runId))
        .where(and(
          eq(heartbeatRunChanges.companyId, input.companyId),
          inArray(heartbeatRunChanges.issueId, issueIds),
          inArray(heartbeatRunChanges.status, ["captured", "pending"]),
        )),
    ]);

    const agentNames = new Map(agentRows.map((agent) => [agent.id, agent.name]));
    const eventsByIssue = new Map<string, FeedStatusEvent[]>();
    for (const row of eventRows) {
      const change = readStatusChange(row.details);
      if (!change) continue;
      const list = eventsByIssue.get(row.entityId) ?? [];
      list.push({ id: row.id, at: row.at, to: change.to });
      eventsByIssue.set(row.entityId, list);
    }
    const runsByIssue = new Map<string, FeedRun[]>();
    for (const row of runRows) {
      if (!row.issueId) continue;
      const list = runsByIssue.get(row.issueId) ?? [];
      list.push({
        runId: row.runId,
        startedAt: row.startedAt,
        endedAt: row.finishedAt ?? row.finalizedAt ?? null,
        status: row.status,
        files: (row.files ?? []).map((file) => ({ path: file.path, additions: file.additions, deletions: file.deletions, binary: file.binary })),
      });
      runsByIssue.set(row.issueId, list);
    }
    const shownByIssue = new Map<string, Map<string, FeedRun[]>>();
    for (const issueId of issueIds) {
      shownByIssue.set(issueId, attributeRuns(eventsByIssue.get(issueId) ?? [], runsByIssue.get(issueId) ?? []));
    }

    const noteFor = (issueId: string, eventId: string, at: Date): string | null => {
      const events = eventsByIssue.get(issueId) ?? [];
      const index = events.findIndex((event) => event.id === eventId);
      const previousAt = index > 0 ? events[index - 1]!.at.getTime() : Number.NEGATIVE_INFINITY;
      const upper = at.getTime() + NOTE_GRACE_MS;
      let latest: string | null = null;
      for (const comment of commentRows) {
        if (comment.issueId !== issueId) continue;
        const time = comment.createdAt.getTime();
        if (time >= previousAt && time <= upper) latest = comment.body;
      }
      const excerpt = latest === null ? null : noteExcerpt(latest);
      return excerpt ? excerpt : null;
    };

    const items: TeamFeedItem[] = page.map((row) => ({
      id: row.id,
      at: row.createdAt.toISOString(),
      actor: actorFor({ actorType: row.actorType, agentId: row.agentId }, agentNames),
      reason: reasonFor(row.details),
      issue: { id: row.issueId, identifier: row.identifier, title: row.title },
      fromStatus: row.change.from,
      toStatus: row.change.to,
      note: noteFor(row.issueId, row.id, row.createdAt),
      changes: summarizeChanges(shownByIssue.get(row.issueId)?.get(row.id) ?? []),
    }));
    const last = rows[limit - 1];
    return { items, nextCursor: hasMore && last ? `${last.createdAtText}|${last.id}` : null };
  }

  return { list };
}

export type TeamFeedService = ReturnType<typeof createTeamFeedService>;
