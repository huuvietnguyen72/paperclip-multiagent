import { describe, expect, it } from "vitest";
import type { LiveEvent } from "@paperclipai/shared";
import { invalidationTargets } from "./live-invalidation";

const event = (type: LiveEvent["type"], payload: Record<string, unknown> = {}): LiveEvent =>
  ({ id: 1, companyId: "c", type, createdAt: "2026-11-10T10:00:00Z", payload });

describe("invalidationTargets", () => {
  it("refreshes live runs and agents on run activity", () => {
    expect(invalidationTargets(event("heartbeat.run.activity"))).toEqual(["liveRuns", "agents"]);
  });

  it("also refreshes runs and costs when a run finishes", () => {
    expect(invalidationTargets(event("heartbeat.run.status", { status: "succeeded" })))
      .toEqual(["liveRuns", "agents", "runs", "costSummary", "costByAgent"]);
    expect(invalidationTargets(event("heartbeat.run.status", { status: "running" }))).toEqual(["liveRuns", "agents"]);
  });

  it("refreshes issues and approvals on issue activity", () => {
    expect(invalidationTargets(event("activity.logged", { action: "issue.updated", entityType: "issue" }))).toEqual(["issues", "approvals"]);
  });

  it("refreshes agents when an agent's config changes or an approval is decided", () => {
    expect(invalidationTargets(event("activity.logged", { action: "agent.updated", entityType: "agent" }))).toContain("agents");
    expect(invalidationTargets(event("activity.logged", { action: "approval.approved", entityType: "approval" }))).toContain("agents");
  });

  it("ignores unrelated events", () => {
    expect(invalidationTargets(event("plugin.ui.updated" as LiveEvent["type"]))).toEqual([]);
  });
});
