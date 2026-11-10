import { describe, expect, it } from "vitest";
import type { CostByAgent, CostSummary, HeartbeatRun, Issue } from "@paperclipai/shared";
import type { OfficeAgentView } from "./agent-state";
import {
  aggregateOfficeStats,
  formatAgo,
  formatDuration,
  formatElapsed,
  formatSpend,
  formatTokens,
  utcMonthStart,
} from "./stats";

const view = (id: string, group: OfficeAgentView["group"] = "idle") => ({ id, group, hasLiveRun: group === "working" }) as OfficeAgentView;
const run = (agentId: string, startedAt: string | null, finishedAt: string | null) =>
  ({ id: `${agentId}-${startedAt}`, agentId, startedAt, finishedAt }) as unknown as HeartbeatRun;
const doneIssue = (id: string, assigneeAgentId: string, completedAt: string) =>
  ({ id, status: "done", assigneeAgentId, completedAt }) as unknown as Issue;
const cost = (agentId: string | null, input: number, cached: number, output: number, costCents: number) =>
  ({ agentId, inputTokens: input, cachedInputTokens: cached, outputTokens: output, costCents }) as CostByAgent;
const summary = (spendCents: number) => ({ spendCents }) as CostSummary;

describe("formatters", () => {
  it("formats tokens compactly", () => {
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(12_300)).toBe("12.3K");
    expect(formatTokens(100_400_000)).toBe("100M");
  });
  it("formats spend in dollars", () => {
    expect(formatSpend(5.77)).toBe("$0.06");
    expect(formatSpend(0)).toBe("$0.00");
    expect(formatSpend(123_456)).toBe("$1,234.56");
  });
  it("formats durations and elapsed clocks", () => {
    expect(formatDuration(51_600_000)).toBe("14h 20m");
    expect(formatDuration(300_000)).toBe("5m");
    expect(formatDuration(0)).toBe("0m");
    expect(formatElapsed(760_000)).toBe("12:40");
    expect(formatElapsed(3_723_000)).toBe("1:02:03");
  });
});

describe("formatAgo", () => {
  it("describes how long ago in Vietnamese", () => {
    expect(formatAgo(20_000)).toBe("vừa xong");
    expect(formatAgo(5 * 60_000)).toBe("5 phút trước");
    expect(formatAgo(2 * 3_600_000 + 60_000)).toBe("2 giờ trước");
    expect(formatAgo(3 * 86_400_000)).toBe("3 ngày trước");
  });
});

describe("utcMonthStart", () => {
  it("returns the first instant of the UTC month", () => {
    expect(utcMonthStart(new Date("2026-11-10T08:00:00Z")).toISOString()).toBe("2026-11-01T00:00:00.000Z");
  });
});

describe("aggregateOfficeStats", () => {
  const base = {
    agents: [view("a", "working"), view("b")],
    issues: [] as Issue[],
    runs: [] as HeartbeatRun[],
    costSummary: summary(0),
    costByAgent: [] as CostByAgent[],
    now: new Date("2026-11-10T08:00:00Z"),
  };

  it("counts only issues completed this month", () => {
    const stats = aggregateOfficeStats({
      ...base,
      issues: [doneIssue("i1", "a", "2026-10-31T23:59:00Z"), doneIssue("i2", "a", "2026-11-02T10:00:00Z")],
    });
    expect(stats.company.doneCount).toBe(1);
    expect(stats.byAgent.get("a")?.doneCount).toBe(1);
  });

  it("counts a live run that started last month only from the month start", () => {
    const stats = aggregateOfficeStats({
      ...base,
      runs: [run("a", "2026-10-31T23:00:00Z", null)],
      now: new Date("2026-11-01T01:00:00Z"),
    });
    expect(stats.company.runtimeMs).toBe(3_600_000);
    expect(stats.byAgent.get("a")?.runtimeMs).toBe(3_600_000);
  });

  it("flags runtime as approximate when the run list hit its cap inside this month", () => {
    const capped = Array.from({ length: 3 }, (_, i) => run("a", `2026-11-0${i + 2}T10:00:00Z`, `2026-11-0${i + 2}T10:10:00Z`));
    expect(aggregateOfficeStats({ ...base, runs: capped, runsLimit: 3 }).company.runtimeApproximate).toBe(true);
    const reachesLastMonth = [...capped.slice(0, 2), run("a", "2026-10-30T10:00:00Z", "2026-10-30T10:10:00Z")];
    expect(aggregateOfficeStats({ ...base, runs: reachesLastMonth, runsLimit: 3 }).company.runtimeApproximate).toBe(false);
    expect(aggregateOfficeStats({ ...base, runs: capped.slice(0, 2), runsLimit: 3 }).company.runtimeApproximate).toBe(false);
  });

  it("adds finished runs and skips runs without a start", () => {
    const stats = aggregateOfficeStats({
      ...base,
      runs: [run("b", "2026-11-05T10:00:00Z", "2026-11-05T10:30:00Z"), run("b", null, null), run("b", "2026-10-01T00:00:00Z", "2026-10-01T01:00:00Z")],
    });
    expect(stats.company.runtimeMs).toBe(1_800_000);
  });

  it("sums tokens including rows without an agent and takes spend from the summary", () => {
    const stats = aggregateOfficeStats({
      ...base,
      costSummary: summary(5.77),
      costByAgent: [cost("a", 100, 50, 25, 3), cost(null, 10, 0, 0, 1)],
    });
    expect(stats.company.tokens).toBe(185);
    expect(stats.company.spendCents).toBe(5.77);
    expect(stats.byAgent.get("a")).toMatchObject({ tokens: 175, spendCents: 3 });
  });

  it("counts agents with a live run as working even when they need attention", () => {
    const stats = aggregateOfficeStats({
      ...base,
      agents: [{ id: "pm", group: "attention", hasLiveRun: true } as OfficeAgentView, view("b")],
    });
    expect(stats.company.workingCount).toBe(1);
  });

  it("reports working and shown counts", () => {
    const stats = aggregateOfficeStats(base);
    expect(stats.company.workingCount).toBe(1);
    expect(stats.company.shownCount).toBe(2);
  });
});
