import type { LiveEvent } from "@paperclipai/shared";
import { strings } from "./strings";

export type FeedFilter = "all" | "attention" | "runs" | "comments";

export interface FeedItem {
  id: string;
  at: string;
  agentId: string | null;
  issueId: string | null;
  kind: "run" | "comment" | "issue";
  tone: "ok" | "warn" | "error";
  text: string;
}

export interface FeedContext {
  agentName(id: string): string | null;
  issueIdentifier(id: string): string | null;
}

export const FEED_MAX_ITEMS = 50;

const asString = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);

export function feedItemFromLiveEvent(e: LiveEvent, ctx: FeedContext): FeedItem | null {
  const payload = e.payload ?? {};
  const base = {
    id: `${e.type}:${e.id}`,
    at: e.createdAt,
    agentId: asString(payload.agentId),
    issueId: asString(payload.issueId),
  };

  if (e.type === "heartbeat.run.status") {
    const status = asString(payload.status);
    if (status === "running") return { ...base, kind: "run", tone: "ok", text: strings.feed.runStarted };
    if (status === "succeeded") return { ...base, kind: "run", tone: "ok", text: strings.feed.runSucceeded };
    if (status === "failed" || status === "timed_out") {
      const error = asString(payload.error);
      return { ...base, kind: "run", tone: "error", text: error ? `${strings.feed.runFailed} · ${error}` : strings.feed.runFailed };
    }
    if (status === "cancelled" || status === "interrupted") return { ...base, kind: "run", tone: "warn", text: strings.feed.runCancelled };
    return null;
  }

  if (e.type === "activity.logged") {
    const action = asString(payload.action);
    const identifier = base.issueId ? (ctx.issueIdentifier(base.issueId) ?? base.issueId) : "";
    if (action === "issue.comment_added") {
      if (payload.actorType !== "agent") return null;
      return { ...base, agentId: base.agentId ?? asString(payload.actorId), kind: "comment", tone: "ok", text: strings.feed.commentIn(identifier) };
    }
    if (action === "issue.updated") {
      const details = (payload.details ?? {}) as Record<string, unknown>;
      const status = asString(details.status);
      if (status === "done") return { ...base, kind: "issue", tone: "ok", text: strings.feed.issueDone(identifier) };
      if (status === "blocked" || status === "in_review") return { ...base, kind: "issue", tone: "warn", text: strings.feed.issueStatus(identifier, status) };
    }
    return null;
  }

  return null;
}

export function pushFeedItem(list: readonly FeedItem[], item: FeedItem, max: number = FEED_MAX_ITEMS): FeedItem[] {
  // A live event can be delivered twice (reconnect replay); the first copy keeps its place.
  if (list.some((existing) => existing.id === item.id)) return [...list];
  return [item, ...list].slice(0, max);
}

export function filterFeed(list: readonly FeedItem[], filter: FeedFilter): FeedItem[] {
  switch (filter) {
    case "attention":
      return list.filter((item) => item.tone !== "ok");
    case "runs":
      return list.filter((item) => item.kind === "run");
    case "comments":
      return list.filter((item) => item.kind === "comment");
    default:
      return [...list];
  }
}
