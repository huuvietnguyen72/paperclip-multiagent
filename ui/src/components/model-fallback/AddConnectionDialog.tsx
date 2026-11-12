import { useState } from "react";
import { MODEL_FALLBACK_CARRY_KEYS, type AiRuntimeConnectionBinding } from "@paperclipai/shared";
import { agentsApi } from "@/api/agents";
import { AiConnectionField } from "@/components/ai-connections/AiConnectionField";
import { AdapterMark } from "@/components/AdapterMark";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  ADD_KIND_ORDER,
  OPENCODE_DEFAULT_MODEL,
  addConnectionBody,
  adapterTypeForKind,
  buildNewConnection,
  canAddConnection,
  sameBinding,
  type AddConnectionKind,
  type AgentPatchBody,
  type ChainAgent,
} from "@/lib/model-fallback/edit";
import { strings } from "@/lib/model-fallback/strings";
import { cn } from "@/lib/utils";
import { DialogError, FieldRow, ModelSelect, errorMessage, useModelOptions } from "./fields";

const MARK_FOR_KIND: Record<AddConnectionKind, string> = {
  opencodeGo: "opencode_local",
  claudeAccount: "claude_local",
  codex: "codex_local",
};

export interface AddConnectionDialogProps {
  agent: ChainAgent & { id: string; name: string };
  companyId: string;
  onClose: () => void;
  save: (build: (fresh: ChainAgent) => AgentPatchBody) => Promise<unknown>;
}

export function AddConnectionDialog({ agent, companyId, onClose, save }: AddConnectionDialogProps) {
  const [kind, setKind] = useState<AddConnectionKind | null>(null);
  const [model, setModel] = useState("");
  const [binding, setBinding] = useState<AiRuntimeConnectionBinding | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testNote, setTestNote] = useState<string | null>(null);

  const adapterType = kind ? adapterTypeForKind(kind) : "opencode_local";
  const options = useModelOptions(companyId, adapterType, null);
  const effectiveModel =
    model || options.find((option) => option.id === OPENCODE_DEFAULT_MODEL && kind === "opencodeGo")?.id || options[0]?.id || "";
  const defaultBinding = (agent.runtimeConfig?.aiConnection ?? undefined) as AiRuntimeConnectionBinding | undefined;
  const needsAccount = kind === "claudeAccount";
  const accountProblem = needsAccount && (!binding || sameBinding(binding, defaultBinding));
  const full = !canAddConnection(agent);
  const ready = kind !== null && Boolean(effectiveModel) && !accountProblem && !full;

  const selectKind = (next: AddConnectionKind) => {
    setKind(next);
    setModel("");
    setBinding(undefined);
    setTestNote(null);
    setError(null);
  };

  const build = () => buildNewConnection(agent, kind as AddConnectionKind, { model: effectiveModel, ...(binding && needsAccount ? { aiConnection: binding } : {}) });

  const onAdd = async () => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      const connection = build();
      await save((fresh) => addConnectionBody(fresh, connection));
      onClose();
    } catch (caught) {
      setError(errorMessage(caught, strings.addDialog.addFailed));
    } finally {
      setBusy(false);
    }
  };

  const onTest = async () => {
    if (!ready) return;
    setTesting(true);
    setTestNote(null);
    try {
      const connection = build();
      const carried: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(agent.adapterConfig ?? {})) {
        if (MODEL_FALLBACK_CARRY_KEYS.includes(key)) carried[key] = value;
      }
      const result = await agentsApi.testEnvironment(companyId, connection.adapterType, {
        adapterConfig: { ...carried, ...connection.adapterConfig },
        ...(connection.aiConnection ? { aiConnection: connection.aiConnection } : {}),
        agentId: agent.id,
      });
      setTestNote(strings.addDialog.testResult[result.status] ?? result.status);
    } catch (caught) {
      setTestNote(errorMessage(caught, strings.addDialog.testFailed));
    } finally {
      setTesting(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => (!open && !busy ? onClose() : undefined)}>
      <DialogContent className="max-h-(--sz-85vh) overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{strings.addDialog.title}</DialogTitle>
          <DialogDescription>{strings.addDialog.note}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <FieldRow label={strings.addDialog.typeLabel}>
            <div className="grid gap-2">
              {ADD_KIND_ORDER.map((candidate) => {
                const copy = strings.addDialog.types[candidate];
                return (
                  <button
                    key={candidate}
                    type="button"
                    aria-pressed={kind === candidate}
                    onClick={() => selectKind(candidate)}
                    className={cn(
                      "flex items-start gap-3 rounded-lg border bg-card p-3 text-left text-card-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      kind === candidate && "border-ring bg-accent",
                    )}
                  >
                    <AdapterMark type={MARK_FOR_KIND[candidate]} className="mt-0.5 size-5 shrink-0" />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2 text-sm font-medium">
                        {copy.label}
                      </span>
                      <span className="block text-xs text-muted-foreground">{copy.description}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </FieldRow>

          {needsAccount ? (
            <FieldRow label={strings.editDialog.account}>
              <AiConnectionField
                companyId={companyId}
                agentId={agent.id}
                agentName={agent.name}
                adapterType="claude_local"
                model={effectiveModel}
                value={binding}
                onChange={setBinding}
              />
              {binding && sameBinding(binding, defaultBinding) ? (
                <p className="text-xs text-destructive">{strings.addDialog.sameAccount}</p>
              ) : null}
            </FieldRow>
          ) : null}

          {kind ? (
            <ModelSelect options={options} value={effectiveModel} onChange={setModel} />
          ) : null}
          {full ? <p className="text-xs text-muted-foreground">{strings.addDialog.limitReached}</p> : null}
          {testNote ? <p className="text-sm text-muted-foreground">{testNote}</p> : null}
          <DialogError message={error} />
        </div>
        <DialogFooter className="sm:justify-between">
          <Button type="button" variant="outline" disabled={!ready || testing || busy} onClick={onTest}>
            {testing ? strings.addDialog.testing : strings.addDialog.testConnection}
          </Button>
          <div className="flex gap-2">
            <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>
              {strings.editDialog.cancel}
            </Button>
            <Button type="button" disabled={!ready || busy} onClick={onAdd}>
              {busy ? strings.addDialog.adding : strings.addDialog.add}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
