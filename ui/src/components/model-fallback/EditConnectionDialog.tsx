import { useState } from "react";
import type { AiRuntimeConnectionBinding } from "@paperclipai/shared";
import { AiConnectionField } from "@/components/ai-connections/AiConnectionField";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { getAdapterDisplay } from "@/adapters/adapter-display-registry";
import {
  editDefaultBody,
  editFallbackBody,
  effortKeyFor,
  readFallback,
  removeFallbackBody,
  sameBinding,
  type AgentPatchBody,
  type ChainAgent,
} from "@/lib/model-fallback/edit";
import { strings } from "@/lib/model-fallback/strings";
import type { FallbackConnection } from "./ConnectionCard";
import { DialogError, EffortSelect, FieldRow, ModelSelect, errorMessage, useModelOptions } from "./fields";

const BINDABLE = new Set(["claude_local", "codex_local"]);

export interface EditConnectionDialogProps {
  agent: ChainAgent & { id: string; name: string };
  companyId: string;
  connection: FallbackConnection;
  onClose: () => void;
  save: (body: AgentPatchBody) => Promise<unknown>;
}

/** Edits the default (the agent's own fields) or one fallback entry of the chain. */
export function EditConnectionDialog({ agent, companyId, connection, onClose, save }: EditConnectionDialogProps) {
  const isDefault = connection.isDefault;
  const entry = isDefault ? null : readFallback(agent).connections.find((candidate) => candidate.id === connection.id) ?? null;
  const adapterType = isDefault ? agent.adapterType : (entry?.adapterType ?? connection.adapterType);
  const config = (isDefault ? agent.adapterConfig : entry?.adapterConfig) ?? {};
  const currentModel = typeof config.model === "string" ? config.model : (connection.model ?? "");
  const effortKey = effortKeyFor(adapterType);
  const initialBinding = ((isDefault ? agent.runtimeConfig?.aiConnection : entry?.aiConnection) ?? undefined) as
    | AiRuntimeConnectionBinding
    | undefined;

  const [model, setModel] = useState(currentModel);
  const [effort, setEffort] = useState(effortKey && typeof config[effortKey] === "string" ? (config[effortKey] as string) : "");
  const [binding, setBinding] = useState<AiRuntimeConnectionBinding | undefined>(initialBinding);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const options = useModelOptions(companyId, adapterType, currentModel);

  const run = async (build: () => AgentPatchBody) => {
    setBusy(true);
    setError(null);
    try {
      await save(build());
      onClose();
    } catch (caught) {
      setError(errorMessage(caught, strings.editDialog.saveFailed));
    } finally {
      setBusy(false);
    }
  };

  const onSave = () =>
    run(() => {
      const edit = {
        model,
        effort,
        ...(sameBinding(binding, initialBinding) ? {} : { aiConnection: binding ?? null }),
      };
      return isDefault ? editDefaultBody(agent, edit) : editFallbackBody(agent, connection.id, edit);
    });

  const title = `${strings.editDialog.title(connection.position)}${isDefault ? strings.editDialog.mainSuffix : ""}`;

  return (
    <Dialog open onOpenChange={(open) => (!open && !busy ? onClose() : undefined)}>
      <DialogContent className="max-h-(--sz-85vh) overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{strings.editDialog.note}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <FieldRow label={strings.editDialog.harness}>
            <div className="text-sm text-foreground">{getAdapterDisplay(adapterType).label}</div>
          </FieldRow>
          <FieldRow label={strings.editDialog.account}>
            {BINDABLE.has(adapterType) ? (
              <AiConnectionField
                companyId={companyId}
                agentId={agent.id}
                agentName={agent.name}
                adapterType={adapterType}
                model={model}
                value={binding}
                onChange={setBinding}
              />
            ) : (
              <div className="text-sm text-foreground">{connection.accountLabel ?? strings.stats.none}</div>
            )}
          </FieldRow>
          <ModelSelect options={options} value={model} onChange={setModel} currentModel={currentModel} />
          {effortKey ? <EffortSelect value={effort} onChange={setEffort} /> : null}
          <DialogError message={error} />
        </div>
        <DialogFooter className="sm:justify-between">
          <div>
            {!isDefault ? (
              <Button
                type="button"
                variant="ghost"
                className="text-destructive"
                disabled={busy}
                onClick={() => run(() => removeFallbackBody(agent, connection.id))}
              >
                {strings.editDialog.remove}
              </Button>
            ) : null}
          </div>
          <div className="flex gap-2">
            <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>
              {strings.editDialog.cancel}
            </Button>
            <Button type="button" disabled={busy || !model} onClick={onSave}>
              {busy ? strings.editDialog.saving : strings.editDialog.save}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
