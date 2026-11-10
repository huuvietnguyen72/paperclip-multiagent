import type { AnalyticsRange } from "./date-range";

export interface RunSpan {
  agentId: string;
  startedAt: Date | string | null;
  finishedAt: Date | string | null;
}

const toMs = (value: Date | string | null): number | null => {
  if (value == null) return null;
  const ms = typeof value === "string" ? Date.parse(value) : value.getTime();
  return Number.isFinite(ms) ? ms : null;
};

/** Merge overlapping [start, end) intervals so concurrent runs of one agent are not double counted. */
function mergeIntervals(intervals: Array<[number, number]>): Array<[number, number]> {
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const [start, end] of sorted) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

/**
 * Minutes each agent worked in each bucket (an hour or a day, see `range.unit`). Buckets that start after `now`
 * are `null` so a line stops at the present instead of dropping to zero.
 */
export function workTimeSeries(runs: RunSpan[], buckets: Date[], range: AnalyticsRange, now: Date): Map<string, Array<number | null>> {
  const nowMs = now.getTime();
  const rangeStart = range.start.getTime();
  const rangeEnd = Math.min(range.end.getTime(), nowMs);
  const bucketMs = buckets.map((bucket) => bucket.getTime());
  const bucketEnds = bucketMs.map((start, i) => bucketMs[i + 1] ?? range.end.getTime());

  const intervalsByAgent = new Map<string, Array<[number, number]>>();
  for (const run of runs) {
    const start = toMs(run.startedAt);
    if (start == null) continue;
    const end = toMs(run.finishedAt) ?? nowMs;
    const clippedStart = Math.max(start, rangeStart);
    const clippedEnd = Math.min(end, rangeEnd);
    if (clippedEnd <= clippedStart) continue;
    const list = intervalsByAgent.get(run.agentId) ?? [];
    list.push([clippedStart, clippedEnd]);
    intervalsByAgent.set(run.agentId, list);
  }

  const series = new Map<string, Array<number | null>>();
  for (const [agentId, intervals] of intervalsByAgent) {
    const values: Array<number | null> = bucketMs.map((start) => (start > nowMs ? null : 0));
    for (const [start, end] of mergeIntervals(intervals)) {
      bucketMs.forEach((bucketStart, i) => {
        const overlap = Math.min(end, bucketEnds[i]) - Math.max(start, bucketStart);
        if (overlap > 0 && values[i] != null) values[i] = (values[i] as number) + overlap / 60_000;
      });
    }
    series.set(agentId, values.map((value) => (value == null ? null : Math.round(value * 10) / 10)));
  }
  return series;
}

/** An all-zero (or future-null) series for agents with no runs in the range. */
export function emptySeries(buckets: Date[], now: Date): Array<number | null> {
  return buckets.map((bucket) => (bucket.getTime() > now.getTime() ? null : 0));
}
