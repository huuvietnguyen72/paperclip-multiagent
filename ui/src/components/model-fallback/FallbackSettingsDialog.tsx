import { useState } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { connectionLabel } from "@/lib/model-fallback/format";
import { readFallback, reorderBody, settingsBody, type AgentPatchBody, type ChainAgent } from "@/lib/model-fallback/edit";
import { strings } from "@/lib/model-fallback/strings";
import type { FallbackConnection } from "./ConnectionCard";
import { DialogError, FieldRow, errorMessage } from "./fields";

export interface FallbackSettingsDialogProps {
  agent: ChainAgent;
  /** Connections in chain order, default first. */
  connections: FallbackConnection[];
  /** Effective wait (minutes) shown when the agent has none stored. */
  noResetWaitMinutes: number;
  onClose: () => void;
  save: (body: AgentPatchBody) => Promise<unknown>;
}

/** Auto-switch toggle, wait time when no reset time is known, and a keyboard-friendly chain order list. */
export function FallbackSettingsDialog({ agent, connections, noResetWaitMinutes, onClose, save }: FallbackSettingsDialogProps) {
  const stored = readFallback(agent);
  const [enabled, setEnabled] = useState(stored.enabled);
  const [wait, setWait] = useState(String(stored.noResetWaitMinutes ?? noResetWaitMinutes));
  const [order, setOrder] = useState(connections.map((connection) => connection.id));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const byId = new Map(connections.map((connection) => [connection.id, connection] as const));
  const waitNumber = Number(wait);
  const waitValid = Number.isInteger(waitNumber) && waitNumber >= 1 && waitNumber <= 1440;
  const originalOrder = connections.map((connection) => connection.id);
  const orderChanged = order.some((id, index) => id !== originalOrder[index]);

  const move = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= order.length) return;
    const next = order.slice();
    [next[index], next[target]] = [next[target], next[index]];
    setOrder(next);
  };

  const onSave = async () => {
    if (!waitValid) return;
    setBusy(true);
    setError(null);
    try {
      const reordered: AgentPatchBody = orderChanged ? reorderBody(agent, order) : { runtimeConfig: agent.runtimeConfig ?? {} };
      const keepWait = stored.noResetWaitMinutes != null || waitNumber !== noResetWaitMinutes;
      const settings = settingsBody(
        { ...agent, runtimeConfig: reordered.runtimeConfig },
        { enabled, ...(keepWait ? { noResetWaitMinutes: waitNumber } : {}) },
      );
      await save({ ...reordered, runtimeConfig: settings.runtimeConfig });
      onClose();
    } catch (caught) {
      setError(errorMessage(caught, strings.settingsDialog.saveFailed));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => (!open && !busy ? onClose() : undefined)}>
      <DialogContent className="max-h-(--sz-85vh) overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{strings.settingsDialog.title}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-3">
            <span id="mf-auto-switch" className="text-sm text-foreground">
              {strings.settingsDialog.autoSwitch}
            </span>
            <ToggleSwitch aria-labelledby="mf-auto-switch" checked={enabled} onCheckedChange={setEnabled} />
          </div>
          <FieldRow label={strings.settingsDialog.noResetWait} htmlFor="mf-wait">
            <Input
              id="mf-wait"
              type="number"
              inputMode="numeric"
              min={1}
              max={1440}
              value={wait}
              aria-invalid={!waitValid}
              onChange={(event) => setWait(event.target.value)}
            />
          </FieldRow>
          <FieldRow label={strings.settingsDialog.order}>
            <ol className="space-y-1.5">
              {order.map((id, index) => {
                const connection = byId.get(id);
                if (!connection) return null;
                const label = connectionLabel(connection.adapterType, connection.model);
                return (
                  <li key={id} className="flex items-center gap-2 rounded-md border bg-card px-2.5 py-1.5 text-sm">
                    <span className="w-5 shrink-0 text-xs text-muted-foreground">{index + 1}</span>
                    <span className="min-w-0 flex-1 truncate">{label}</span>
                    {index === 0 ? <span className="shrink-0 text-xs text-muted-foreground">{strings.settingsDialog.defaultTag}</span> : null}
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      aria-label={strings.settingsDialog.moveUp(label)}
                      disabled={index === 0}
                      onClick={() => move(index, -1)}
                    >
                      <ArrowUp aria-hidden />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      aria-label={strings.settingsDialog.moveDown(label)}
                      disabled={index === order.length - 1}
                      onClick={() => move(index, 1)}
                    >
                      <ArrowDown aria-hidden />
                    </Button>
                  </li>
                );
              })}
            </ol>
          </FieldRow>
          <DialogError message={error} />
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>
            {strings.settingsDialog.cancel}
          </Button>
          <Button type="button" disabled={busy || !waitValid} onClick={onSave}>
            {busy ? strings.settingsDialog.saving : strings.settingsDialog.save}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
