import { describe, expect, it } from "vitest";
import type { CostByAgentModel } from "@paperclipai/shared";
import { bucketStarts, customRange, presetRange, toDateInput } from "./date-range";
import { modelUsage, topAgentsForModel } from "./model-usage";
import { assignSeriesIndex, seriesStyle } from "./series-style";
import { workTimeSeries } from "./work-time";

// All dates are built in local time so the tests hold in any timezone.
const local = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min);
const NOW = local(2026, 11, 10, 15, 30);

describe("date ranges", () => {
  it("today is the current local day, bucketed by hour", () => {
    const range = presetRange("today", NOW);
    expect(range).toEqual({ start: local(2026, 11, 10), end: local(2026, 11, 11), unit: "hour" });
    expect(bucketStarts(range)).toHaveLength(24);
    expect(bucketStarts(range)[14]).toEqual(local(2026, 11, 10, 14));
  });

  it("yesterday is the previous local day, bucketed by hour", () => {
    expect(presetRange("yesterday", NOW)).toEqual({ start: local(2026, 11, 9), end: local(2026, 11, 10), unit: "hour" });
  });

  it("7 and 30 days end today and are bucketed by day", () => {
    const week = presetRange("7d", NOW);
    expect(week).toEqual({ start: local(2026, 11, 4), end: local(2026, 11, 11), unit: "day" });
    expect(bucketStarts(week)).toHaveLength(7);
    expect(presetRange("30d", NOW).start).toEqual(local(2026, 10, 12));
    expect(bucketStarts(presetRange("30d", NOW))).toHaveLength(30);
  });

  it("a custom single day is hourly; a custom span is daily, inclusive and order-insensitive", () => {
    expect(customRange("2026-11-08", "2026-11-08")).toEqual({ start: local(2026, 11, 8), end: local(2026, 11, 9), unit: "hour" });
    expect(customRange("2026-11-08", "2026-11-03")).toEqual({ start: local(2026, 11, 3), end: local(2026, 11, 9), unit: "day" });
  });

  it("formats a date for a date input", () => {
    expect(toDateInput(local(2026, 1, 5))).toBe("2026-01-05");
  });
});

describe("workTimeSeries", () => {
  const today = presetRange("today", NOW);
  const buckets = bucketStarts(today);
  const run = (agentId: string, start: Date, end: Date | null) => ({ agentId, startedAt: start.toISOString(), finishedAt: end?.toISOString() ?? null });

  it("splits a run across the hours it spans, in minutes", () => {
    const series = workTimeSeries([run("be", local(2026, 11, 10, 9, 40), local(2026, 11, 10, 10, 30))], buckets, today, NOW);
    expect(series.get("be")?.[9]).toBe(20);
    expect(series.get("be")?.[10]).toBe(30);
    expect(series.get("be")?.[8]).toBe(0);
  });

  it("does not double count overlapping runs of one agent", () => {
    const series = workTimeSeries([
      run("be", local(2026, 11, 10, 9, 0), local(2026, 11, 10, 9, 40)),
      run("be", local(2026, 11, 10, 9, 20), local(2026, 11, 10, 9, 50)),
    ], buckets, today, NOW);
    expect(series.get("be")?.[9]).toBe(50);
  });

  it("counts a live run up to now and leaves future hours empty", () => {
    const series = workTimeSeries([run("qa", local(2026, 11, 10, 15, 0), null)], buckets, today, NOW);
    expect(series.get("qa")?.[15]).toBe(30);
    expect(series.get("qa")?.[16]).toBeNull();
  });

  it("clips runs that started before the range", () => {
    const series = workTimeSeries([run("pm", local(2026, 11, 9, 23, 30), local(2026, 11, 10, 0, 15))], buckets, today, NOW);
    expect(series.get("pm")?.[0]).toBe(15);
  });

  it("buckets a multi-day range by day", () => {
    const week = presetRange("7d", NOW);
    const series = workTimeSeries([run("be", local(2026, 11, 5, 23, 0), local(2026, 11, 6, 1, 0))], bucketStarts(week), week, NOW);
    expect(series.get("be")?.slice(0, 3)).toEqual([0, 60, 60]);
  });
});

describe("model usage", () => {
  const row = (agentId: string, agentName: string, model: string, input: number, output: number, costCents = 0) =>
    ({ agentId, agentName, provider: "anthropic", biller: "anthropic", billingType: "subscription_included", model, eventCount: 1, estimatedEventCount: 0, costCents, inputTokens: input, cachedInputTokens: 0, outputTokens: output }) as CostByAgentModel;
  const rows = [
    row("be", "Backend", "claude-sonnet-5-5", 300, 20),
    row("qa", "QA", "claude-sonnet-5-5", 100, 10),
    row("ceo", "CEO", "claude-opus-5-5", 150, 5, 4),
    row("fe", "Frontend", "gpt-6.1-sol", 50, 5),
    row("be", "Backend", "claude-opus-5-5", 10, 0),
  ];

  it("ranks models by total tokens with readable labels", () => {
    const usage = modelUsage(rows);
    expect(usage.map((m) => [m.model, m.tokens])).toEqual([
      ["claude-sonnet-5-5", 430],
      ["claude-opus-5-5", 165],
      ["gpt-6.1-sol", 55],
    ]);
    expect(usage[0].label).toBe("Sonnet 5.5");
    expect(usage[1].costCents).toBe(4);
  });

  it("uses the provider's brand mark for alias model ids", () => {
    const aliasRows = [
      { ...row("pm", "PM", "opus", 10, 0), provider: "anthropic" },
      { ...row("devops", "DevOps", "opencode-go/deepseek-v4.1-flash", 5, 0), provider: "opencode-go" },
      { ...row("fe", "Frontend", "gpt-6.1-sol", 3, 0), provider: "openai" },
    ] as CostByAgentModel[];
    expect(modelUsage(aliasRows).map((m) => [m.label, m.markType])).toEqual([
      ["Opus", "claude_local"],
      ["Deepseek V4.1 Flash", "opencode_local"],
      ["GPT-6.1 Sol", "codex_local"],
    ]);
  });

  it("lists every agent of a model, most tokens first", () => {
    expect(topAgentsForModel(rows, "claude-sonnet-5-5").map((a) => [a.agentName, a.tokens])).toEqual([["Backend", 320], ["QA", 110]]);
    const crowd = Array.from({ length: 9 }, (_, i) => row(`a${i}`, `Agent ${i}`, "claude-sonnet-5-5", 10 + i, 0));
    expect(topAgentsForModel(crowd, "claude-sonnet-5-5")).toHaveLength(9);
    expect(topAgentsForModel(crowd, "claude-sonnet-5-5")[0].agentName).toBe("Agent 8");
  });
});

describe("series styles", () => {
  it("assigns colours by stable agent order, not by rank", () => {
    const index = assignSeriesIndex(["be", "ceo", "qa"]);
    expect(index.get("ceo")).toBe(1);
    expect(seriesStyle(0)).toEqual({ color: "var(--series-1)", dashed: false });
    expect(seriesStyle(7)).toEqual({ color: "var(--series-8)", dashed: false });
  });

  it("reuses the eight hues with a dashed line beyond eight series", () => {
    expect(seriesStyle(8)).toEqual({ color: "var(--series-1)", dashed: true });
    expect(seriesStyle(9)).toEqual({ color: "var(--series-2)", dashed: true });
  });
});
