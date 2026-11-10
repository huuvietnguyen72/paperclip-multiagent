import type { LiveEvent } from "@paperclipai/shared";

export type OfficeQueryPart = "agents" | "liveRuns" | "issues" | "approvals" | "runs" | "costSummary" | "costByAgent";

const FINAL_RUN_STATUSES = new Set(["succeeded", "failed", "cancelled", "timed_out", "interrupted"]);

/** Which Office queries a live event makes stale. */
export function invalidationTargets(event: LiveEvent): OfficeQueryPart[] {
  const payload = event.payload ?? {};
  if (event.type.startsWith("heartbeat.run.") || event.type.startsWith("agent.")) {
    const targets: OfficeQueryPart[] = ["liveRuns", "agents"];
    if (event.type === "heartbeat.run.status" && FINAL_RUN_STATUSES.has(String(payload.status))) {
      targets.push("runs", "costSummary", "costByAgent");
    }
    return targets;
  }
  if (event.type === "activity.logged") {
    const targets: OfficeQueryPart[] = ["issues", "approvals"];
    const action = String(payload.action ?? "");
    // Agent config (model, adapter), hires and approval decisions arrive as activity, not as agent.* events.
    if (payload.entityType === "agent" || action.startsWith("agent.") || action.startsWith("approval.")) targets.push("agents");
    return targets;
  }
  return [];
}
