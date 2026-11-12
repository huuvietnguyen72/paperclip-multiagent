import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { agentsApi } from "@/api/agents";
import { NativeSelect } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { strings } from "@/lib/model-fallback/strings";

export interface ModelOption {
  id: string;
  label: string;
}

/** Models of a harness from the adapter catalog, always including the value currently stored. */
export function useModelOptions(companyId: string, adapterType: string, current: string | null | undefined): ModelOption[] {
  const query = useQuery({
    queryKey: ["model-fallback", "models", companyId, adapterType],
    queryFn: () => agentsApi.adapterModels(companyId, adapterType),
    staleTime: 60_000,
  });
  const options: ModelOption[] = [...(query.data ?? [])];
  if (current && !options.some((option) => option.id === current)) options.unshift({ id: current, label: current });
  return options;
}

export function FieldRow({ label, htmlFor, children }: { label: string; htmlFor?: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor} className="text-sm text-muted-foreground">
        {label}
      </Label>
      {children}
    </div>
  );
}

export function ModelSelect({
  options,
  value,
  onChange,
  currentModel,
}: {
  options: ModelOption[];
  value: string;
  onChange: (model: string) => void;
  currentModel?: string | null;
}) {
  return (
    <FieldRow label={strings.editDialog.model} htmlFor="mf-model">
      <NativeSelect id="mf-model" aria-label={strings.editDialog.model} value={value} onChange={(event) => onChange(event.target.value)}>
        {value === "" ? <option value="" /> : null}
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
            {currentModel && option.id === currentModel ? ` (${strings.editDialog.modelCurrent})` : ""}
          </option>
        ))}
      </NativeSelect>
    </FieldRow>
  );
}

export function EffortSelect({ value, levels, onChange }: { value: string; levels: string[]; onChange: (effort: string) => void }) {
  const labels = strings.editDialog.effortLevels;
  const all = value && !levels.includes(value) ? [...levels, value] : levels;
  return (
    <FieldRow label={strings.editDialog.thinkingEffort} htmlFor="mf-effort">
      <NativeSelect id="mf-effort" aria-label={strings.editDialog.thinkingEffort} value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">{strings.editDialog.effortAuto}</option>
        {all.map((key) => (
          <option key={key} value={key}>
            {labels[key] ?? key}
          </option>
        ))}
      </NativeSelect>
    </FieldRow>
  );
}

export function DialogError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="text-sm text-destructive">
      {message}
    </p>
  );
}

export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
