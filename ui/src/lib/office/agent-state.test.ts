import { describe, expect, it } from "vitest";
import type { Agent, Approval, Issue } from "@paperclipai/shared";
import type { LiveRunForIssue } from "@/api/heartbeats";
import { deriveOfficeAgents, type OfficeInputs } from "./agent-state";

const NOW = Date.parse("2026-11-10T10:00:00Z");

function agent(overrides: Partial<Agent> & { id: string; role: string }): Agent {
  return {
    name: overrides.id,
    urlKey: overrides.id,
    status: "idle",
    pauseReason: null,
    adapterType: "claude_local",
    adapterConfig: { model: "claude-sonnet-5-5" },
    appearance: { schemaVersion: 1, characterVersion: "cap-v1", paletteId: "coral-mint" },
    lastHeartbeatAt: null,
    ...overrides,
  } as unknown as Agent;
}

function issue(overrides: Partial<Issue> & { id: string }): Issue {
  return { identifier: overrides.id.toUpperCase(), status: "todo", assigneeAgentId: null, ...overrides } as unknown as Issue;
}

function liveRun(overrides: Partial<LiveRunForIssue> & { agentId: string }): LiveRunForIssue {
  return {
    id: `run-${overrides.agentId}`,
    status: "running",
    invocationSource: "assignment",
    triggerDetail: null,
    startedAt: "2026-11-10T09:47:20Z",
    finishedAt: null,
    createdAt: "2026-11-10T09:47:19Z",
    agentName: overrides.agentId,
    adapterType: "claude_local",
    issueId: null,
    ...overrides,
  } as LiveRunForIssue;
}

function inputs(overrides: Partial<OfficeInputs>): OfficeInputs {
  return {
    agents: [],
    liveRuns: [],
    issues: [],
    pendingApprovals: [],
    recentCommentAt: new Map(),
    recentAssignedAt: new Map(),
    adapterLabels: new Map(),
    fallbackActive: new Map(),
    now: NOW,
    ...overrides,
  };
}

function only(input: Partial<OfficeInputs>) {
  const views = deriveOfficeAgents(inputs(input));
  expect(views).toHaveLength(1);
  return views[0];
}

describe("deriveOfficeAgents", () => {
  it("hides terminated and pending_approval agents", () => {
    const views = deriveOfficeAgents(inputs({
      agents: [
        agent({ id: "a", role: "qa", status: "terminated" } as Partial<Agent> & { id: string; role: string }),
        agent({ id: "b", role: "qa", status: "pending_approval" } as Partial<Agent> & { id: string; role: string }),
        agent({ id: "c", role: "qa" }),
      ],
    }));
    expect(views.map((v) => v.id)).toEqual(["c"]);
  });

  it("puts an error agent in attention with an error marker", () => {
    const view = only({ agents: [agent({ id: "a", role: "qa", status: "error" } as never)] });
    expect(view.group).toBe("attention");
    expect(view.marker).toBe("error");
    expect(view.spot).toBe("desk");
    expect(view.pose).toBe("standing");
  });

  it("flags budget pauses but not manual pauses", () => {
    const budget = only({ agents: [agent({ id: "a", role: "qa", status: "paused", pauseReason: "budget" } as never)] });
    expect(budget.group).toBe("attention");
    expect(budget.marker).toBe("attention");

    const manual = only({ agents: [agent({ id: "a", role: "qa", status: "paused", pauseReason: "manual" } as never)] });
    expect(manual.group).toBe("idle");
    expect(manual.muted).toBe(true);
    expect(manual.marker).toBe("paused");
    expect(manual.spot).toBe("desk");
  });

  it("keeps idle executives (CEO, PM) at their desks while other idle agents go to the pantry", () => {
    const views = deriveOfficeAgents(inputs({
      agents: [agent({ id: "ceo", role: "ceo" }), agent({ id: "pm", role: "pm" }), agent({ id: "be", role: "engineer" })],
    }));
    const byId = new Map(views.map((view) => [view.id, view]));
    expect(byId.get("ceo")).toMatchObject({ group: "idle", spot: "desk", pose: "idle" });
    expect(byId.get("pm")).toMatchObject({ group: "idle", spot: "desk", pose: "idle" });
    expect(byId.get("be")).toMatchObject({ group: "idle", spot: "pantry", pose: "idle" });
  });

  it("treats a block covered by another agent as waiting, not attention", () => {
    const view = only({
      agents: [agent({ id: "tl", role: "cto" })],
      issues: [issue({
        id: "qua-20", status: "blocked", assigneeAgentId: "tl",
        blockerAttention: { state: "covered", reason: "active_dependency", sampleBlockerIdentifier: "QUA-25" },
      } as never)],
    });
    expect(view.group).toBe("idle");
    expect(view.waitingOn).toBe("QUA-25");
    expect(view.spot).toBe("pantry");
  });

  it("flags a block that needs a human", () => {
    const view = only({
      agents: [agent({ id: "tl", role: "cto" })],
      issues: [issue({
        id: "qua-20", status: "blocked", assigneeAgentId: "tl",
        blockerAttention: { state: "needs_attention", reason: "attention_required", sampleBlockerIdentifier: null },
      } as never)],
    });
    expect(view.group).toBe("attention");
  });

  it("flags a blocked issue whose blocker attention is none or missing", () => {
    for (const blockerAttention of [{ state: "none", reason: null, sampleBlockerIdentifier: null }, undefined]) {
      const view = only({
        agents: [agent({ id: "tl", role: "cto" })],
        issues: [issue({ id: "qua-20", status: "blocked", assigneeAgentId: "tl", blockerAttention } as never)],
      });
      expect(view.group).toBe("attention");
      expect(view.attentionIssue?.identifier).toBe("QUA-20");
    }
  });

  it("keeps the run timer and status for an attention agent that is running", () => {
    const view = only({
      agents: [agent({ id: "pm", role: "pm" })],
      liveRuns: [liveRun({ agentId: "pm", currentStatusMessage: "Reviewing" })],
      pendingApprovals: [{ id: "ap", requestedByAgentId: "pm", payload: {} } as unknown as Approval],
    });
    expect(view.group).toBe("attention");
    expect(view.hasLiveRun).toBe(true);
    expect(view.runStartedAt).toBe("2026-11-10T09:47:20Z");
    expect(view.statusLine).toBe("Reviewing");
  });

  it("marks agents without a run as not running", () => {
    expect(only({ agents: [agent({ id: "ceo", role: "ceo" })] }).hasLiveRun).toBe(false);
  });

  it("flags in_review issues waiting on an approval", () => {
    const view = only({
      agents: [agent({ id: "qa", role: "qa" })],
      issues: [issue({
        id: "qua-25", status: "in_review", assigneeAgentId: "qa",
        reviewAttention: { state: "covered", reason: null, paths: [{ kind: "approval", label: "x", responder: null, since: null, ref: null }] },
      } as never)],
    });
    expect(view.group).toBe("attention");
  });

  it("flags agents with a pending approval", () => {
    const view = only({
      agents: [agent({ id: "pm", role: "pm" })],
      pendingApprovals: [{ id: "ap", requestedByAgentId: "pm", payload: {} } as unknown as Approval],
    });
    expect(view.group).toBe("attention");
  });

  it("sends an agent running a shell tool to the server room", () => {
    const view = only({
      agents: [agent({ id: "be", role: "engineer" })],
      liveRuns: [liveRun({ agentId: "be", currentToolName: "Bash" })],
    });
    expect(view.group).toBe("working");
    expect(view.spot).toBe("server");
    expect(view.pose).toBe("standing");
  });

  it("keeps an agent editing code typing at its desk", () => {
    const view = only({
      agents: [agent({ id: "be", role: "engineer" })],
      liveRuns: [liveRun({ agentId: "be", issueId: "i24", currentStatusMessage: "Editing src/app.ts" })],
      issues: [issue({ id: "i24", identifier: "QUA-24", assigneeAgentId: "be", status: "in_progress" } as never)],
    });
    expect(view.group).toBe("working");
    expect(view.spot).toBe("desk");
    expect(view.pose).toBe("typing");
    expect(view.statusLine).toBe("Editing src/app.ts");
    expect(view.runStartedAt).toBe("2026-11-10T09:47:20Z");
    expect(view.currentIssue).toEqual({ id: "i24", identifier: "QUA-24" });
  });

  it("handles a live run with no issue", () => {
    const view = only({
      agents: [agent({ id: "ceo", role: "ceo" })],
      liveRuns: [liveRun({ agentId: "ceo", issueId: null })],
    });
    expect(view.group).toBe("working");
    expect(view.currentIssue).toBeNull();
  });

  it("sends a recent commenter to the meeting room for a while", () => {
    const recent = only({ agents: [agent({ id: "pm", role: "pm" })], recentCommentAt: new Map([["pm", NOW - 10_000]]) });
    expect(recent.spot).toBe("meeting");
    expect(recent.pose).toBe("standing");
    // After the meeting an executive goes back to their own room, any other idle agent to the pantry.
    const stale = only({ agents: [agent({ id: "pm", role: "pm" })], recentCommentAt: new Map([["pm", NOW - 30_000]]) });
    expect(stale.spot).toBe("desk");
    const staleEngineer = only({ agents: [agent({ id: "be", role: "engineer" })], recentCommentAt: new Map([["be", NOW - 30_000]]) });
    expect(staleEngineer.spot).toBe("pantry");
  });

  it("flashes a newly assigned agent and sends it to its desk", () => {
    const view = only({ agents: [agent({ id: "fe", role: "engineer" })], recentAssignedAt: new Map([["fe", NOW - 2_000]]) });
    expect(view.assignedFlashUntil).toBe(NOW + 3_000);
    expect(view.spot).toBe("desk");
  });

  it("shows the current model badge", () => {
    const view = only({ agents: [agent({ id: "ceo", role: "ceo", adapterConfig: { model: "claude-opus-5-5" } })] });
    expect(view.badge).toEqual({ label: "Opus 5.5", markType: "claude_local" });
    expect(view.department).toBe("executive");
    expect(view.paletteId).toBe("coral-mint");
  });

  it("sorts by department order then name", () => {
    const views = deriveOfficeAgents(inputs({
      agents: [
        agent({ id: "qa", name: "QA", role: "qa" } as never),
        agent({ id: "pm", name: "PM", role: "pm" } as never),
        agent({ id: "ceo", name: "CEO", role: "ceo" } as never),
        agent({ id: "be", name: "Backend", role: "engineer" } as never),
      ],
    }));
    expect(views.map((v) => v.id)).toEqual(["ceo", "pm", "be", "qa"]);
  });

  it("office badge shows fallback model when active", () => {
    const view = only({
      agents: [agent({ id: "a", role: "qa" })],
      fallbackActive: new Map([
        ["a", { agentId: "a", connectionId: "c2", adapterType: "codex_local", model: "gpt-5.5", isFallback: true }],
      ]),
    });
    expect(view.badge.label).toBe("GPT-5.5");
    expect(view.badge.markType).toBe("codex_local");
    expect(view.isFallback).toBe(true);
  });

  it("office badge is unchanged when the agent is not on a fallback", () => {
    const view = only({ agents: [agent({ id: "a", role: "qa" })] });
    expect(view.badge.label).toBe("Sonnet 5.5");
    expect(view.isFallback).toBe(false);
    expect(view.fallbackUnknown).toBe(false);
  });

  it("office badge marks the in-use connection unknown when the active query failed and the agent has a chain", () => {
    const chained = agent({ id: "a", role: "qa", runtimeConfig: { modelFallback: {
      enabled: true, connections: [{ id: "c2", adapterType: "codex_local", adapterConfig: { model: "gpt-5.5" } }] } } } as never);
    const view = only({ agents: [chained], fallbackActiveUnknown: true });
    expect(view.badge.label).toBe("Sonnet 5.5");
    expect(view.isFallback).toBe(false);
    expect(view.fallbackUnknown).toBe(true);
    // Without a chain the configured model is certain.
    expect(only({ agents: [agent({ id: "a", role: "qa" })], fallbackActiveUnknown: true }).fallbackUnknown).toBe(false);
  });
});
