import { useEffect, useMemo, useState } from "react";
import { BarChart3 } from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { AnalyticsRangePicker, type RangeSelection } from "@/components/analytics/AnalyticsRangePicker";
import { ModelUsagePanel } from "@/components/analytics/ModelUsagePanel";
import { WorkTimeChart, type ChartSeries, type LegendEntry } from "@/components/analytics/WorkTimeChart";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { bucketStarts, customRange, presetRange, toDateInput, type RangePreset } from "@/lib/analytics/date-range";
import { modelUsage, topAgentsForModel } from "@/lib/analytics/model-usage";
import { assignSeriesIndex, seriesStyle } from "@/lib/analytics/series-style";
import { analyticsStrings as s } from "@/lib/analytics/strings";
import { emptySeries, workTimeSeries } from "@/lib/analytics/work-time";
import { useAnalyticsData } from "./analytics/useAnalyticsData";

const DEFAULT_VISIBLE = 5;

function selectionFor(preset: RangePreset, now: Date): RangeSelection {
  const range = presetRange(preset, now);
  return { preset, from: toDateInput(range.start), to: toDateInput(new Date(range.end.getTime() - 1)) };
}

function useMinuteClock(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

function AnalyticsView({ companyId }: { companyId: string }) {
  const now = useMinuteClock();
  const [selection, setSelection] = useState<RangeSelection>(() => selectionFor("today", new Date()));
  const range = useMemo(
    () => (selection.preset ? presetRange(selection.preset, now) : customRange(selection.from, selection.to)),
    // A preset follows the clock only when the day changes, not every minute.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selection, now.toDateString()],
  );
  const data = useAnalyticsData(companyId, range);

  const buckets = useMemo(() => bucketStarts(range), [range]);
  const perAgent = useMemo(() => workTimeSeries(data.runs, buckets, range, now), [data.runs, buckets, range, now]);
  const colourIndex = useMemo(() => assignSeriesIndex(data.agents.map((agent) => agent.id)), [data.agents]);

  // Busiest agents are shown by default; the owner's toggles override that per agent.
  const [toggles, setToggles] = useState<Map<string, boolean>>(new Map());
  const defaultVisible = useMemo(() => {
    const totals = data.agents.map((agent) => ({
      id: agent.id,
      total: (perAgent.get(agent.id) ?? []).reduce<number>((sum, value) => sum + (value ?? 0), 0),
    }));
    return new Set(totals.sort((a, b) => b.total - a.total).slice(0, DEFAULT_VISIBLE).map((entry) => entry.id));
  }, [data.agents, perAgent]);
  const isVisible = (id: string) => toggles.get(id) ?? defaultVisible.has(id);

  const legend: LegendEntry[] = data.agents.map((agent) => ({
    id: agent.id,
    name: agent.name,
    ...seriesStyle(colourIndex.get(agent.id) ?? 0),
    visible: isVisible(agent.id),
  }));
  const series: ChartSeries[] = legend
    .filter((entry) => entry.visible)
    .map((entry) => ({
      id: entry.id,
      name: entry.name,
      color: entry.color,
      dashed: entry.dashed,
      values: perAgent.get(entry.id) ?? emptySeries(buckets, now),
    }));

  const models = useMemo(() => modelUsage(data.costRows), [data.costRows]);
  const [pickedModel, setPickedModel] = useState<string | null>(null);
  const selectedModel = models.some((model) => model.model === pickedModel) ? pickedModel : (models[0]?.model ?? null);
  const topAgents = useMemo(
    () => (selectedModel ? topAgentsForModel(data.costRows, selectedModel) : []),
    [data.costRows, selectedModel],
  );

  if (data.error && data.agents.length === 0) return <EmptyState icon={BarChart3} message={s.loadError} />;

  return (
    <div className="flex flex-col gap-4 p-4">
      <AnalyticsRangePicker
        value={selection}
        onPreset={(preset) => setSelection(selectionFor(preset, new Date()))}
        onCustom={(from, to) => {
          if (from && to) setSelection({ preset: null, from, to });
        }}
      />

      <section data-analytics-section="work" className="min-w-0 rounded-xl border border-border p-4">
        <h2 className="text-sm font-semibold text-foreground">{s.work.title}</h2>
        <p className="mb-3 text-xs text-muted-foreground">
          {range.unit === "hour" ? s.work.perHour : s.work.perDay}
          {data.approximate ? ` · ${s.work.approximate}` : ""}
        </p>
        <WorkTimeChart
          buckets={buckets}
          unit={range.unit}
          series={series}
          legend={legend}
          onToggle={(id) => setToggles((current) => new Map(current).set(id, !isVisible(id)))}
        />
      </section>

      <section data-analytics-section="models" className="min-w-0 rounded-xl border border-border p-4">
        <h2 className="text-sm font-semibold text-foreground">{s.models.title}</h2>
        <p className="mb-3 text-xs text-muted-foreground">{s.models.subtitle}</p>
        <ModelUsagePanel models={models} selectedModel={selectedModel} onSelectModel={setPickedModel} topAgents={topAgents} />
      </section>
    </div>
  );
}

export function Analytics() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: s.pageTitle }]);
  }, [setBreadcrumbs]);

  if (!selectedCompanyId) return null;
  return <AnalyticsView companyId={selectedCompanyId} />;
}

export default Analytics;
