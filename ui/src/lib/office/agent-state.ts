import { resolveAgentAppearance, type Agent, type Approval, type Issue } from "@paperclipai/shared";
import type { LiveRunForIssue } from "@/api/heartbeats";
import { DEPARTMENTS, departmentForRole, type DepartmentId, type SharedAreaId } from "./departments";
import { effectiveModelFor, fallbackActiveUnknown, type ActiveFallbackEntry } from "@/lib/model-fallback/effective";
import { modelBadgeFor, type ModelBadge } from "./model-badge";

export type OfficeGroup = "attention" | "working" | "idle";
export type OfficeSpot = "desk" | SharedAreaId;
export type OfficePose = "typing" | "standing" | "idle";
export type OfficeMarker = "attention" | "error" | "paused" | null;

export interface OfficeAgentView {
  id: string;
  name: string;
  urlKey: string;
  role: string;
  department: DepartmentId;
  paletteId: string;
  muted: boolean;
  group: OfficeGroup;
  /** True whenever a run is live, including for agents grouped under attention. */
  hasLiveRun: boolean;
  spot: OfficeSpot;
  pose: OfficePose;
  marker: OfficeMarker;
  currentIssue: { id: string; identifier: string | null } | null;
  /** Issue that needs the owner (attention group only). */
  attentionIssue: { id: string; identifier: string | null } | null;
  statusLine: string | null;
  runStartedAt: string | null;
  waitingOn: string | null;
  lastHeartbeatAt: string | null;
  badge: ModelBadge;
  /** True when the badge shows a fallback connection instead of the configured model. */
  isFallback: boolean;
  /** True when the in-use connection could not be loaded and the agent may be on a fallback. */
  fallbackUnknown?: boolean;
  assignedFlashUntil: number | null;
}

export interface OfficeInputs {
  agents: Agent[];
  liveRuns: LiveRunForIssue[];
  issues: Issue[];
  pendingApprovals: Approval[];
  /** agentId → epoch ms of the agent's last issue comment. */
  recentCommentAt: ReadonlyMap<string, number>;
  /** agentId → epoch ms of the last issue newly assigned to the agent. */
  recentAssignedAt: ReadonlyMap<string, number>;
  /** adapterType → (modelId → label) from the adapter's model list. */
  adapterLabels: ReadonlyMap<string, ReadonlyMap<string, string>>;
  /** agentId -> connection the agent is actually running on, for agents on a fallback. */
  fallbackActive?: ReadonlyMap<string, ActiveFallbackEntry>;
  /** The company-active query failed: agents with a fallback chain show an "unknown" hint on the badge. */
  fallbackActiveUnknown?: boolean;
  now: number;
}

export const MEETING_LINGER_MS = 25_000;
export const ASSIGNED_FLASH_MS = 5_000;

const HIDDEN_STATUSES = new Set(["terminated", "pending_approval"]);
const LIVE_RUN_STATUSES = new Set(["running", "queued"]);
const FLAGGED_PAUSE_REASONS = new Set(["budget", "system"]);
const HUMAN_REVIEW_PATHS = new Set(["approval", "interaction", "human_reviewer"]);
const SHELL_TOOL = /^(bash|shell|exec|command|run_shell_command|local_shell)/i;
const SHELL_STATUS = /\b(test|tests|build|lint|typecheck|pnpm|npm|docker)\b/i;

function toIso(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  return typeof value === "string" ? value : value.toISOString();
}

function issueRef(issue: Issue) {
  return { id: issue.id, identifier: issue.identifier ?? null };
}

function needsOwner(issue: Issue): boolean {
  if (issue.status === "blocked") {
    // Only a block covered by another agent's active work is not the owner's business (spec §2.2).
    return issue.blockerAttention?.state !== "covered";
  }
  if (issue.status === "in_review") {
    return (issue.reviewAttention?.paths ?? []).some((path) => HUMAN_REVIEW_PATHS.has(path.kind));
  }
  return false;
}

function approvalInvolves(approval: Approval, agentId: string): boolean {
  return approval.requestedByAgentId === agentId || approval.payload?.agentId === agentId;
}

export function deriveOfficeAgents(input: OfficeInputs): OfficeAgentView[] {
  const issuesById = new Map(input.issues.map((issue) => [issue.id, issue]));
  const departmentOrder = new Map(DEPARTMENTS.map((department, index) => [department.id, index]));

  const views = input.agents
    .filter((agent) => !HIDDEN_STATUSES.has(agent.status))
    .map((agent): OfficeAgentView => {
      const assigned = input.issues.filter((issue) => issue.assigneeAgentId === agent.id && issue.status !== "done" && issue.status !== "cancelled");
      const run = input.liveRuns.find((candidate) => candidate.agentId === agent.id && LIVE_RUN_STATUSES.has(candidate.status));
      const ownerIssue = assigned.find(needsOwner) ?? null;
      const pausedFlagged = agent.status === "paused" && agent.pauseReason != null && FLAGGED_PAUSE_REASONS.has(agent.pauseReason);
      const hasApproval = input.pendingApprovals.some((approval) => approvalInvolves(approval, agent.id));
      const isError = agent.status === "error";
      const manualPause = agent.status === "paused" && !pausedFlagged;

      const group: OfficeGroup = isError || pausedFlagged || hasApproval || ownerIssue
        ? "attention"
        : run
          ? "working"
          : "idle";

      let marker: OfficeMarker = null;
      if (isError) marker = "error";
      else if (group === "attention") marker = "attention";
      else if (manualPause) marker = "paused";

      const runIssue = run?.issueId ? issuesById.get(run.issueId) : undefined;
      const currentIssue = run?.issueId ? (runIssue ? issueRef(runIssue) : { id: run.issueId, identifier: null }) : null;
      const statusLine = run ? (run.currentStatusMessage ?? run.currentToolName ?? null) : null;
      const covered = assigned.find((issue) => issue.status === "blocked" && issue.blockerAttention?.state === "covered");

      const assignedAt = input.recentAssignedAt.get(agent.id);
      const assignedFlashUntil = assignedAt != null && assignedAt + ASSIGNED_FLASH_MS > input.now ? assignedAt + ASSIGNED_FLASH_MS : null;
      const commentedAt = input.recentCommentAt.get(agent.id);
      const inMeeting = commentedAt != null && input.now - commentedAt < MEETING_LINGER_MS;

      let spot: OfficeSpot;
      let pose: OfficePose;
      if (inMeeting) {
        spot = "meeting";
        pose = "standing";
      } else if (group === "working") {
        const shell = SHELL_TOOL.test(run?.currentToolName ?? "") || SHELL_STATUS.test(statusLine ?? "");
        spot = shell ? "server" : "desk";
        pose = shell ? "standing" : "typing";
      } else if (group === "attention") {
        spot = "desk";
        pose = "standing";
      } else {
        spot = manualPause ? "desk" : "pantry";
        pose = "idle";
      }
      if (assignedFlashUntil != null) spot = "desk";

      const effective = effectiveModelFor(agent, input.fallbackActive);
      return {
        id: agent.id,
        name: agent.name,
        urlKey: agent.urlKey,
        role: agent.role,
        department: departmentForRole(agent.role),
        paletteId: resolveAgentAppearance(agent.appearance, agent.id).paletteId,
        muted: manualPause,
        group,
        hasLiveRun: run != null,
        spot,
        pose,
        marker,
        currentIssue,
        attentionIssue: ownerIssue ? issueRef(ownerIssue) : null,
        statusLine,
        runStartedAt: run?.startedAt ?? null,
        waitingOn: group === "idle" ? (covered?.blockerAttention?.sampleBlockerIdentifier ?? null) : null,
        lastHeartbeatAt: toIso(agent.lastHeartbeatAt),
        badge: modelBadgeFor(effective.adapterType, effective.model, input.adapterLabels.get(effective.adapterType)),
        isFallback: effective.isFallback,
        fallbackUnknown: !effective.isFallback && fallbackActiveUnknown(agent, input.fallbackActiveUnknown ?? false),
        assignedFlashUntil,
      };
    });

  return views.sort((a, b) =>
    (departmentOrder.get(a.department) ?? 0) - (departmentOrder.get(b.department) ?? 0) || a.name.localeCompare(b.name));
}
