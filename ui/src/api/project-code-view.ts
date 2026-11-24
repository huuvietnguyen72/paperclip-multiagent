import type {
  ProjectCodeViewStatus,
  ResolvedWorkspaceResource,
  WorkspaceFileContent,
  WorkspaceFileListResponse,
} from "@paperclipai/shared";
import { api, type RequestOptions } from "./client";

/** Project "Code" tab: read-only browsing of a project's local code copy, kept current by the server. */

export interface ProjectCodeFileListQuery {
  path?: string | null;
  q?: string | null;
  mode?: "all";
  limit?: number;
  offset?: number;
}

const base = (projectId: string, workspaceId: string) =>
  `/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(workspaceId)}`;

function listSearch(query: ProjectCodeFileListQuery): string {
  const params = new URLSearchParams();
  if (query.path) params.set("path", query.path);
  if (query.q) params.set("q", query.q);
  if (query.limit) params.set("limit", String(query.limit));
  if (query.offset) params.set("offset", String(query.offset));
  const search = params.toString();
  return search ? `?${search}` : "";
}

export const projectCodeViewApi = {
  list(projectId: string): Promise<{ workspaces: ProjectCodeViewStatus[] }> {
    return api.get(`/projects/${encodeURIComponent(projectId)}/code-view`);
  },
  refresh(projectId: string, workspaceId: string, reason: "open" | "manual"): Promise<ProjectCodeViewStatus> {
    return api.post(`${base(projectId, workspaceId)}/code-view/refresh`, { reason });
  },
  listFiles(projectId: string, workspaceId: string, query: ProjectCodeFileListQuery, options?: RequestOptions): Promise<WorkspaceFileListResponse> {
    return api.get(`${base(projectId, workspaceId)}/file-resources/list${listSearch(query)}`, options);
  },
  resolve(projectId: string, workspaceId: string, path: string): Promise<ResolvedWorkspaceResource> {
    return api.get(`${base(projectId, workspaceId)}/file-resources/resolve?${new URLSearchParams({ path })}`);
  },
  content(projectId: string, workspaceId: string, path: string): Promise<WorkspaceFileContent> {
    return api.get(`${base(projectId, workspaceId)}/file-resources/content?${new URLSearchParams({ path })}`);
  },
  downloadUrl(projectId: string, workspaceId: string, path: string): string {
    return `/api${base(projectId, workspaceId)}/file-resources/content?${new URLSearchParams({ path, download: "1" })}`;
  },
};
