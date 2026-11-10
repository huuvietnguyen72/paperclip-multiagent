import { useEffect, useMemo, useRef, useState } from "react";
import { analyticsStrings as s, formatMinutes } from "@/lib/analytics/strings";
import { cn } from "@/lib/utils";

export interface ChartSeries {
  id: string;
  name: string;
  /** Minutes per bucket; null where the bucket is in the future. */
  values: Array<number | null>;
  color: string;
  dashed: boolean;
}

export interface LegendEntry {
  id: string;
  name: string;
  color: string;
  dashed: boolean;
  visible: boolean;
}

/** Plot height in CSS pixels; the width follows the container so text and strokes are never scaled. */
export const CHART_HEIGHT = 260;
const FALLBACK_WIDTH = 720;
const H = CHART_HEIGHT;
const PAD = { left: 40, right: 12, top: 10, bottom: 22 };
const PLOT_H = H - PAD.top - PAD.bottom;
const NICE_HOURS = [1, 2, 4, 6, 8, 12, 16, 24];

function bucketLabel(bucket: Date, unit: "hour" | "day"): string {
  return unit === "hour" ? `${bucket.getHours()}h` : `${String(bucket.getDate()).padStart(2, "0")}/${String(bucket.getMonth() + 1).padStart(2, "0")}`;
}

function bucketTitle(bucket: Date, unit: "hour" | "day"): string {
  if (unit === "day") return bucket.toLocaleDateString("vi-VN", { weekday: "short", day: "2-digit", month: "2-digit" });
  const h = bucket.getHours();
  return `${String(h).padStart(2, "0")}:00–${String((h + 1) % 24).padStart(2, "0")}:00`;
}

/** Line chart of minutes worked per bucket, with a crosshair tooltip, a toggleable legend and a totals table. */
export function WorkTimeChart({ buckets, unit, series, legend, onToggle }: {
  buckets: Date[];
  unit: "hour" | "day";
  series: ChartSeries[];
  legend: LegendEntry[];
  onToggle(id: string): void;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [measured, setMeasured] = useState(0);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const width = Math.round(entries[0]?.contentRect.width ?? 0);
      if (width > 0) setMeasured(width);
    });
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);

  const W = measured || FALLBACK_WIDTH;
  const PLOT_W = W - PAD.left - PAD.right;

  // Hourly charts top out at 60 minutes; daily charts use a "nice" hour ceiling above the busiest day.
  const yMaxMinutes = useMemo(() => {
    if (unit === "hour") return 60;
    const peak = Math.max(0, ...series.flatMap((line) => line.values.map((value) => value ?? 0)));
    return (NICE_HOURS.find((hours) => hours * 60 >= peak) ?? 24) * 60;
  }, [series, unit]);

  const x = (i: number) => PAD.left + (buckets.length <= 1 ? PLOT_W / 2 : (i / (buckets.length - 1)) * PLOT_W);
  const y = (minutes: number) => PAD.top + PLOT_H - (minutes / yMaxMinutes) * PLOT_H;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * yMaxMinutes);
  const labelEvery = Math.max(1, Math.ceil(buckets.length / 8));

  const pathFor = (values: Array<number | null>) => {
    let d = "";
    let pen = false;
    values.forEach((value, i) => {
      if (value == null) {
        pen = false;
        return;
      }
      d += `${pen ? "L" : "M"}${x(i).toFixed(1)} ${y(value).toFixed(1)} `;
      pen = true;
    });
    return d.trim();
  };

  const onMove = (event: React.PointerEvent<SVGRectElement>) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || buckets.length === 0) return;
    const px = ((event.clientX - rect.left) / rect.width) * W;
    const i = Math.round(((px - PAD.left) / PLOT_W) * (buckets.length - 1));
    setHover(Math.min(buckets.length - 1, Math.max(0, i)));
  };

  const hovered = hover != null
    ? series
        .map((line) => ({ line, value: line.values[hover] }))
        .filter((entry): entry is { line: ChartSeries; value: number } => entry.value != null)
        .sort((a, b) => b.value - a.value)
    : [];
  const totals = series
    .map((line) => ({ line, total: line.values.reduce<number>((sum, value) => sum + (value ?? 0), 0) }))
    .sort((a, b) => b.total - a.total);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-1.5">
        {legend.map((entry) => (
          <button
            key={entry.id}
            type="button"
            data-legend={entry.id}
            aria-pressed={entry.visible}
            onClick={() => onToggle(entry.id)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-0.5 text-xs text-foreground",
              !entry.visible && "text-muted-foreground opacity-50",
            )}
          >
            <svg className="h-2 w-4" viewBox="0 0 16 8" aria-hidden>
              <line x1="0" y1="4" x2="16" y2="4" stroke={entry.color} strokeWidth="3" strokeDasharray={entry.dashed ? "4 3" : undefined} />
            </svg>
            {entry.name}
          </button>
        ))}
        <span className="text-xs text-muted-foreground">{s.work.legendHint}</span>
      </div>

      <div ref={frameRef} className="relative">
        <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} height={H} className="block w-full" role="img" aria-label={s.work.title}>
          {ticks.map((tick) => (
            <g key={tick}>
              <line x1={PAD.left} x2={W - PAD.right} y1={y(tick)} y2={y(tick)} className={tick === 0 ? "stroke-muted-foreground" : "stroke-border"} strokeWidth="1" />
              <text x={PAD.left - 6} y={y(tick) + 4} textAnchor="end" className="fill-muted-foreground text-(length:--text-micro)">
                {unit === "hour" ? `${Math.round(tick)}` : `${Math.round(tick / 60)}h`}
              </text>
            </g>
          ))}
          {buckets.map((bucket, i) =>
            i % labelEvery === 0 ? (
              <text key={bucket.getTime()} x={x(i)} y={H - 8} textAnchor="middle" className="fill-muted-foreground text-(length:--text-micro)">
                {bucketLabel(bucket, unit)}
              </text>
            ) : null,
          )}
          {series.map((line) => (
            <path
              key={line.id}
              data-series={line.id}
              d={pathFor(line.values)}
              fill="none"
              stroke={line.color}
              strokeWidth="2"
              strokeLinejoin="round"
              strokeLinecap="round"
              strokeDasharray={line.dashed ? "6 4" : undefined}
            />
          ))}
          {hover != null ? (
            <g>
              <line x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={PAD.top + PLOT_H} className="stroke-muted-foreground" strokeDasharray="3 3" />
              {hovered.map(({ line, value }) => (
                <circle key={line.id} cx={x(hover)} cy={y(value)} r="4" fill={line.color} className="stroke-background" strokeWidth="2" />
              ))}
            </g>
          ) : null}
          <rect
            x={PAD.left}
            y={PAD.top}
            width={PLOT_W}
            height={PLOT_H}
            fill="transparent"
            onPointerMove={onMove}
            onPointerLeave={() => setHover(null)}
          />
        </svg>
        {hover != null && hovered.length > 0 ? (
          <div
            className="pointer-events-none absolute top-2 z-10 min-w-40 rounded-md border border-border bg-background px-2.5 py-2 text-xs shadow-sm"
            style={{ left: `${Math.min(70, (x(hover) / W) * 100 + 2)}%` }}
          >
            <div className="mb-1 font-medium text-foreground">{bucketTitle(buckets[hover], unit)}</div>
            {hovered.map(({ line, value }) => (
              <div key={line.id} className="flex items-center justify-between gap-3 text-muted-foreground">
                <span className="inline-flex items-center gap-1.5">
                  <span className="size-2 rounded-full" style={{ background: line.color }} />
                  {line.name}
                </span>
                <span className="font-mono text-foreground">{formatMinutes(value)}</span>
              </div>
            ))}
          </div>
        ) : null}
      </div>

      <table data-worktime-table className="w-full text-xs">
        <thead>
          <tr className="text-left text-muted-foreground">
            <th className="py-1 font-medium">{s.work.tableAgent}</th>
            <th className="py-1 text-right font-medium">{s.work.tableTotal}</th>
          </tr>
        </thead>
        <tbody>
          {totals.map(({ line, total }) => (
            <tr key={line.id} className="border-t border-border/60">
              <td className="py-1">
                <span className="inline-flex items-center gap-1.5 text-foreground">
                  <span className="size-2 rounded-full" style={{ background: line.color }} />
                  {line.name}
                </span>
              </td>
              <td className="py-1 text-right font-mono text-foreground">{formatMinutes(total)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
