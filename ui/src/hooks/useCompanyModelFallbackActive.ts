import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { modelFallbackApi } from "@/api/model-fallback";
import { fallbackActiveMap } from "@/lib/model-fallback/effective";
import { queryKeys } from "@/lib/queryKeys";

export const MODEL_FALLBACK_ACTIVE_REFRESH_MS = 15_000;

/**
 * One company-level query listing the connection each agent actually runs on. The agent header and Office
 * share it through the same query key. An error never breaks the caller: `activeByAgent` stays empty, so
 * callers show the configured model, and `isError` stays available.
 */
export function useCompanyModelFallbackActive(companyId: string | null | undefined) {
  const query = useQuery({
    queryKey: queryKeys.modelFallback.company(companyId ?? ""),
    queryFn: () => modelFallbackApi.companyActive(companyId!),
    enabled: Boolean(companyId),
    refetchInterval: MODEL_FALLBACK_ACTIVE_REFRESH_MS,
  });
  const data = query.data;
  const activeByAgent = useMemo(() => fallbackActiveMap(data), [data]);
  return { activeByAgent, isError: query.isError, error: query.error };
}
