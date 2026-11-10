import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { Building2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/EmptyState";
import { OfficeRail } from "@/components/office/OfficeRail";
import { OfficeStageFallback } from "@/components/office/OfficeStageFallback";
import { OfficeStatsPanel } from "@/components/office/OfficeStatsPanel";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { useDialog } from "@/context/DialogContext";
import type { FeedFilter } from "@/lib/office/activity-feed";
import { strings } from "@/lib/office/strings";
import { useOfficeData } from "./office/useOfficeData";
import { useRecentTasks } from "./office/useRecentTasks";
import { OfficeRecentTasks } from "@/components/office/OfficeRecentTasks";

// three.js only loads with the stage, so it stays out of every other page's bundle.
const OfficeStage = lazy(() => import("@/components/office/OfficeStage"));

function OfficeView({ companyId }: { companyId: string }) {
  const data = useOfficeData(companyId);
  const { openNewIssue } = useDialog();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [feedFilter, setFeedFilter] = useState<FeedFilter>("all");

  const agentsById = useMemo(() => new Map(data.agents.map((agent) => [agent.id, agent])), [data.agents]);
  const selectedAgent = selectedId ? (agentsById.get(selectedId) ?? null) : null;
  const recent = useRecentTasks(companyId, selectedAgent?.id ?? null);

  // Drop a selection whose agent disappeared (deleted or terminated).
  useEffect(() => {
    if (selectedId && !agentsById.has(selectedId) && !data.isLoading) setSelectedId(null);
  }, [agentsById, selectedId, data.isLoading]);

  const assign = useCallback(
    (agentId: string | null) => {
      const target = agentId ?? data.agents.find((agent) => agent.role === "ceo")?.id ?? null;
      openNewIssue(target ? { assigneeAgentId: target } : undefined);
    },
    [data.agents, openNewIssue],
  );

  if (data.error && data.agents.length === 0) {
    return <EmptyState icon={Building2} message={strings.loadError} />;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <h1 className="text-sm font-semibold text-foreground">{strings.pageTitle}</h1>
        <Button size="xs" data-assign-default onClick={() => assign(null)}>
          {strings.assignWork}
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <div className="order-2 border-border lg:order-1 lg:w-64 lg:shrink-0 lg:border-r">
          <OfficeRail
            agents={data.agents}
            stats={data.stats}
            now={data.now}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onAssign={assign}
          />
        </div>
        <div className="relative order-1 min-h-96 flex-1 lg:order-2">
          <Suspense fallback={<OfficeStageFallback message={strings.loading} />}>
            <OfficeStage
              agents={data.agents}
              now={data.now}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onAssign={assign}
            />
          </Suspense>
        </div>
        <div className="order-3 border-border lg:w-72 lg:shrink-0 lg:border-l">
          <OfficeStatsPanel
            stats={data.stats}
            feed={data.feed}
            filter={feedFilter}
            onFilter={setFeedFilter}
            selectedAgent={selectedAgent}
            agentName={(id) => agentsById.get(id)?.name ?? null}
            onSelectAgent={setSelectedId}
            recentTasks={
              <OfficeRecentTasks
                tasks={recent.tasks}
                isLoading={recent.isLoading}
                agentName={(id) => agentsById.get(id)?.name ?? null}
                selectedName={selectedAgent?.name ?? null}
                now={data.now}
              />
            }
          />
        </div>
      </div>
    </div>
  );
}

export function Office() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: strings.pageTitle }]);
  }, [setBreadcrumbs]);

  if (!selectedCompanyId) return null;
  return <OfficeView companyId={selectedCompanyId} />;
}

export default Office;
