import type { OfficeAgentView } from "@/lib/office/agent-state";

/** Status dot / accent colour of an agent, from the shared agent status tokens. */
export function agentToneClass(agent: Pick<OfficeAgentView, "group" | "marker">): string {
  if (agent.marker === "error") return "bg-(--status-agent-error)";
  if (agent.group === "attention") return "bg-(--status-agent-paused)";
  if (agent.group === "working") return "bg-(--status-agent-running)";
  return "bg-(--status-agent-idle)";
}

export function feedToneClass(tone: "ok" | "warn" | "error"): string {
  if (tone === "error") return "border-l-(--status-agent-error)";
  if (tone === "warn") return "border-l-(--status-agent-paused)";
  return "border-l-(--status-agent-running)";
}
