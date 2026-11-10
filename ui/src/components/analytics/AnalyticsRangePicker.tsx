import type { RangePreset } from "@/lib/analytics/date-range";
import { analyticsStrings as s } from "@/lib/analytics/strings";
import { cn } from "@/lib/utils";

const PRESETS: RangePreset[] = ["yesterday", "today", "7d", "30d"];

export interface RangeSelection {
  preset: RangePreset | null;
  from: string;
  to: string;
}

/** Quick presets plus a from/to pair of date inputs (one day or a span). Filters sit in one row above the charts. */
export function AnalyticsRangePicker({ value, onPreset, onCustom }: {
  value: RangeSelection;
  onPreset(preset: RangePreset): void;
  onCustom(from: string, to: string): void;
}) {
  const input = "h-8 rounded-md border border-border bg-background px-2 text-xs text-foreground";
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="inline-flex overflow-hidden rounded-md border border-border">
        {PRESETS.map((preset) => (
          <button
            key={preset}
            type="button"
            data-range-preset={preset}
            aria-pressed={value.preset === preset}
            onClick={() => onPreset(preset)}
            className={cn(
              "h-8 px-3 text-xs text-muted-foreground hover:text-foreground",
              value.preset === preset && "bg-foreground text-background hover:text-background",
            )}
          >
            {s.presets[preset]}
          </button>
        ))}
      </div>
      <label className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
        {s.from}
        <input
          type="date"
          data-range-from
          className={input}
          value={value.from}
          max={value.to || undefined}
          onInput={(event) => onCustom(event.currentTarget.value, value.to || event.currentTarget.value)}
          onChange={(event) => onCustom(event.currentTarget.value, value.to || event.currentTarget.value)}
        />
      </label>
      <label className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
        {s.to}
        <input
          type="date"
          data-range-to
          className={input}
          value={value.to}
          min={value.from || undefined}
          onInput={(event) => onCustom(value.from || event.currentTarget.value, event.currentTarget.value)}
          onChange={(event) => onCustom(value.from || event.currentTarget.value, event.currentTarget.value)}
        />
      </label>
    </div>
  );
}
