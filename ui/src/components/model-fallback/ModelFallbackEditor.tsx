import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Agent } from "@paperclipai/shared";
import { agentsApi } from "@/api/agents";
import { modelFallbackApi } from "@/api/model-fallback";
import { queryKeys } from "@/lib/queryKeys";
import { reorderBody, type AgentPatchBody, type ChainAgent } from "@/lib/model-fallback/edit";
import { swapDefault } from "@/lib/model-fallback/format";
import { strings } from "@/lib/model-fallback/strings";
import { AddConnectionDialog } from "./AddConnectionDialog";
import type { FallbackConnection } from "./ConnectionCard";
import { EditConnectionDialog } from "./EditConnectionDialog";
import { errorMessage } from "./fields";
import { FallbackSettingsDialog } from "./FallbackSettingsDialog";
import { ModelFallbackTab } from "./ModelFallbackTab";

type Dialog = { kind: "edit"; connection: FallbackConnection } | { kind: "add" } | { kind: "settings" } | null;

/** "Kết nối model" tab with the editing dialogs (edit, add, set default, reorder, settings) wired in. */
export function ModelFallbackEditor({ agent, companyId }: { agent: Agent; companyId: string }) {
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const editable = agent.adapterType !== "paperclip_runner";
  const chainAgent = agent as unknown as ChainAgent & { id: string; name: string };

  // Same key as the tab so the request is shared; the settings dialog reads the effective chain from it.
  const view = useQuery({
    queryKey: [...queryKeys.modelFallback.agent(agent.id), companyId],
    queryFn: () => modelFallbackApi.agentView(agent.id, companyId),
    enabled: editable,
  });

  // Builds the body from the freshly read configuration and sends its revision so a stale write is rejected.
  const save = async (build: (fresh: ChainAgent) => AgentPatchBody) => {
    if (savingRef.current) throw new Error(strings.editDialog.saveFailed);
    savingRef.current = true;
    setSaving(true);
    try {
      const current = await agentsApi.getConfiguration(agent.id, companyId);
      const body = build(current as unknown as ChainAgent);
      await agentsApi.update(
        agent.id,
        {
          ...body,
          ...(body.adapterConfig ? { replaceAdapterConfig: true } : {}),
          expectedConfigurationRevision: current.configurationRevision,
        },
        companyId,
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["agents", "detail"] }),
        queryClient.invalidateQueries({ queryKey: queryKeys.modelFallback.agent(agent.id) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.modelFallback.company(companyId) }),
      ]);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const quick = async (build: (fresh: ChainAgent) => AgentPatchBody, failure: string) => {
    if (savingRef.current) return;
    setActionError(null);
    try {
      await save(build);
    } catch (caught) {
      setActionError(errorMessage(caught, failure));
    }
  };

  if (!editable) return <ModelFallbackTab agent={agent} companyId={companyId} />;

  const connections = [...(view.data?.connections ?? [])].sort((a, b) => a.position - b.position);

  return (
    <div className="space-y-3">
      {actionError ? (
        <p role="alert" className="text-sm text-destructive">
          {actionError}
        </p>
      ) : null}
      <ModelFallbackTab
        agent={agent}
        companyId={companyId}
        onOpenSettings={() => setDialog({ kind: "settings" })}
        onEditConnection={(connection) => setDialog({ kind: "edit", connection })}
        onSetDefault={(connection) => quick((fresh) => swapDefault(fresh, connection.id), strings.editDialog.saveFailed)}
        onAddConnection={() => setDialog({ kind: "add" })}
        busy={saving}
        onReorder={(orderedIds) => quick((fresh) => reorderBody(fresh, orderedIds), strings.hub.reorderFailed)}
      />
      {dialog?.kind === "edit" ? (
        <EditConnectionDialog
          key={dialog.connection.id}
          agent={chainAgent}
          companyId={companyId}
          connection={dialog.connection}
          onClose={() => setDialog(null)}
          save={save}
        />
      ) : null}
      {dialog?.kind === "add" ? (
        <AddConnectionDialog agent={chainAgent} companyId={companyId} onClose={() => setDialog(null)} save={save} />
      ) : null}
      {dialog?.kind === "settings" && view.data ? (
        <FallbackSettingsDialog
          agent={chainAgent}
          connections={connections}
          noResetWaitMinutes={view.data.noResetWaitMinutes}
          onClose={() => setDialog(null)}
          save={save}
        />
      ) : null}
    </div>
  );
}
