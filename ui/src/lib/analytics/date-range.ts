export type RangePreset = "today" | "yesterday" | "7d" | "30d";

/** A local-time span [start, end) and the bucket size used to chart it. */
export interface AnalyticsRange {
  start: Date;
  end: Date;
  unit: "hour" | "day";
}

const DAY_MS = 86_400_000;

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

function rangeOf(start: Date, end: Date): AnalyticsRange {
  // One calendar day (DST-safe: compare calendar days, not milliseconds) is charted by hour, longer spans by day.
  return { start, end, unit: addDays(start, 1).getTime() === end.getTime() ? "hour" : "day" };
}

export function presetRange(preset: RangePreset, now: Date): AnalyticsRange {
  const today = startOfDay(now);
  switch (preset) {
    case "today":
      return rangeOf(today, addDays(today, 1));
    case "yesterday":
      return rangeOf(addDays(today, -1), today);
    case "7d":
      return rangeOf(addDays(today, -6), addDays(today, 1));
    case "30d":
      return rangeOf(addDays(today, -29), addDays(today, 1));
  }
}

function parseDateInput(value: string): Date {
  const [y, m, d] = value.split("-").map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}

/** Inclusive custom range from two `yyyy-mm-dd` values, in either order. */
export function customRange(from: string, to: string): AnalyticsRange {
  let a = parseDateInput(from);
  let b = parseDateInput(to);
  if (a > b) [a, b] = [b, a];
  return rangeOf(a, addDays(b, 1));
}

export function bucketStarts(range: AnalyticsRange): Date[] {
  const starts: Date[] = [];
  if (range.unit === "hour") {
    for (let h = 0; ; h++) {
      const start = new Date(range.start.getFullYear(), range.start.getMonth(), range.start.getDate(), h);
      if (start >= range.end) break;
      starts.push(start);
    }
  } else {
    for (let d = 0; ; d++) {
      const start = addDays(range.start, d);
      if (start >= range.end) break;
      starts.push(start);
    }
  }
  return starts;
}

export function toDateInput(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function rangeDays(range: AnalyticsRange): number {
  return Math.round((range.end.getTime() - range.start.getTime()) / DAY_MS);
}
