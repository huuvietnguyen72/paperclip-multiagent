import type { TeamFeedResponse } from "@paperclipai/shared";
import { api } from "./client";

/** Team feed: read-only task status changes with notes and changed files. */
export const teamFeedApi = {
  list(companyId: string, query: { before?: string | null; limit?: number } = {}): Promise<TeamFeedResponse> {
    const params = new URLSearchParams();
    if (query.before) params.set("before", query.before);
    if (query.limit) params.set("limit", String(query.limit));
    const search = params.toString();
    return api.get(`/companies/${encodeURIComponent(companyId)}/team-feed${search ? `?${search}` : ""}`);
  },
};
