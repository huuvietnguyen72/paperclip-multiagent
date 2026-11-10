import { describe, expect, it } from "vitest";
import type { LiveEvent } from "@paperclipai/shared";
import { feedItemFromLiveEvent, filterFeed, pushFeedItem, type FeedItem } from "./activity-feed";

const ctx = {
  agentName: (id: string) => ({ be: "Backend", qa: "QA Engineer" })[id] ?? null,
  issueIdentifier: (id: string) => ({ i24: "QUA-24", i25: "QUA-25" })[id] ?? null,
};

let seq = 0;
function event(type: LiveEvent["type"], payload: Record<string, unknown>): LiveEvent {
  seq += 1;
  return { id: seq, companyId: "c", type, createdAt: "2026-11-10T10:00:00Z", payload };
}

describe("feedItemFromLiveEvent", () => {
  it("maps run status changes", () => {
    const started = feedItemFromLiveEvent(event("heartbeat.run.status", { agentId: "be", status: "running" }), ctx);
    expect(started).toMatchObject({ kind: "run", tone: "ok", text: "Bắt đầu lượt chạy", agentId: "be" });
    expect(feedItemFromLiveEvent(event("heartbeat.run.status", { agentId: "be", status: "succeeded" }), ctx))
      .toMatchObject({ kind: "run", tone: "ok", text: "Hoàn thành lượt chạy" });
    expect(feedItemFromLiveEvent(event("heartbeat.run.status", { agentId: "be", status: "failed", error: "process lost" }), ctx))
      .toMatchObject({ kind: "run", tone: "error", text: "Lượt chạy lỗi · process lost" });
    expect(feedItemFromLiveEvent(event("heartbeat.run.status", { agentId: "be", status: "timed_out" }), ctx))
      .toMatchObject({ tone: "error", text: "Lượt chạy lỗi" });
    expect(feedItemFromLiveEvent(event("heartbeat.run.status", { agentId: "be", status: "cancelled" }), ctx))
      .toMatchObject({ kind: "run", tone: "warn", text: "Lượt chạy bị huỷ" });
  });

  it("maps agent comments", () => {
    const item = feedItemFromLiveEvent(event("activity.logged", {
      action: "issue.comment_added", actorType: "agent", agentId: "qa", issueId: "i25",
    }), ctx);
    expect(item).toMatchObject({ kind: "comment", tone: "ok", text: "Comment trong QUA-25", agentId: "qa", issueId: "i25" });
  });

  it("ignores comments by people", () => {
    expect(feedItemFromLiveEvent(event("activity.logged", {
      action: "issue.comment_added", actorType: "user", issueId: "i25",
    }), ctx)).toBeNull();
  });

  it("maps issue status changes", () => {
    expect(feedItemFromLiveEvent(event("activity.logged", {
      action: "issue.updated", issueId: "i25", agentId: "qa", details: { status: "in_review" },
    }), ctx)).toMatchObject({ kind: "issue", tone: "warn", text: "QUA-25 → in_review" });
    expect(feedItemFromLiveEvent(event("activity.logged", {
      action: "issue.updated", issueId: "i24", details: { status: "done" },
    }), ctx)).toMatchObject({ kind: "issue", tone: "ok", text: "Hoàn thành QUA-24" });
    expect(feedItemFromLiveEvent(event("activity.logged", {
      action: "issue.updated", issueId: "i24", details: { title: "x" },
    }), ctx)).toBeNull();
  });

  it("ignores unrelated events", () => {
    expect(feedItemFromLiveEvent(event("agent.status", { agentId: "be" }), ctx)).toBeNull();
  });

  it("uses a stable id per event", () => {
    const e = event("heartbeat.run.status", { agentId: "be", status: "running" });
    expect(feedItemFromLiveEvent(e, ctx)?.id).toBe(`heartbeat.run.status:${e.id}`);
  });
});

describe("pushFeedItem / filterFeed", () => {
  const item = (id: string, tone: FeedItem["tone"] = "ok", kind: FeedItem["kind"] = "run"): FeedItem =>
    ({ id, at: "2026-11-10T10:00:00Z", agentId: null, issueId: null, kind, tone, text: id });

  it("keeps newest first and dedupes by id", () => {
    let list = pushFeedItem([], item("a"));
    list = pushFeedItem(list, item("b"));
    list = pushFeedItem(list, item("a"));
    expect(list.map((i) => i.id)).toEqual(["b", "a"]);
  });

  it("caps the list at 50 items", () => {
    let list: FeedItem[] = [];
    for (let i = 0; i < 60; i++) list = pushFeedItem(list, item(`x${i}`));
    expect(list).toHaveLength(50);
    expect(list[0].id).toBe("x59");
  });

  it("filters by kind and attention", () => {
    const list = [item("ok"), item("warn", "warn", "issue"), item("err", "error"), item("c", "ok", "comment")];
    expect(filterFeed(list, "all")).toHaveLength(4);
    expect(filterFeed(list, "attention").map((i) => i.id)).toEqual(["warn", "err"]);
    expect(filterFeed(list, "runs").map((i) => i.id)).toEqual(["ok", "err"]);
    expect(filterFeed(list, "comments").map((i) => i.id)).toEqual(["c"]);
  });
});
