import type { AgentModelFallbackView, CompanyModelFallbackActive } from "@paperclipai/shared";
import { api } from "./client";

export const modelFallbackApi = {
  agentView: (agentId: string, companyId?: string) =>
    api.get<AgentModelFallbackView>(
      `/agents/${encodeURIComponent(agentId)}/model-fallback${companyId ? `?companyId=${encodeURIComponent(companyId)}` : ""}`,
    ),
  companyActive: (companyId: string) =>
    api.get<CompanyModelFallbackActive>(`/companies/${encodeURIComponent(companyId)}/model-fallback/active`),
};
