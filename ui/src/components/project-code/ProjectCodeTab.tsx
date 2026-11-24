import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, RefreshCcw } from "lucide-react";
import type { ProjectCodeViewResult, ProjectCodeViewStatus } from "@paperclipai/shared";
import { projectCodeViewApi } from "@/api/project-code-view";
import { describeError } from "@/api/errors";
import { WorkspaceFileBrowser } from "@/components/WorkspaceFileBrowser";
import { Button } from "@/components/ui/button";
import { useSearchParams } from "@/lib/router";
import { queryKeys } from "@/lib/queryKeys";
import { timeAgo } from "@/lib/timeAgo";
import { ProjectCodeFilePanel } from "./ProjectCodeFilePanel";

/**
 * Project "Code" tab: browse the project's local code copy. The server keeps the copy
 * fast-forwarded (task done, tab open, Update button); this view never edits it.
 */

const NOT_UPDATED: Partial<Record<ProjectCodeViewResult, string>> = {
  skipped_dirty: "Not updated: the local copy has uncommitted changes.",
  skipped_detached: "Not updated: the local copy is not on a tracking branch.",
  diverged: "Not updated: the local copy has commits that are not on the remote.",
};

function headLine(status: ProjectCodeViewStatus): string {
  const updated = status.lastUpdatedAt ? `updated ${timeAgo(status.lastUpdatedAt)}` : "not updated yet";
  const commit = status.head ? `${status.head} "${status.subject ?? ""}"` : "no commit";
  return `${status.branch ?? "detached"} · ${commit} · ${updated}`;
}

function warningFor(status: ProjectCodeViewStatus): string | null {
  if (status.lastResult === "error") return `Last update failed: ${status.lastError ?? "unknown error"}`;
  return status.lastResult ? NOT_UPDATED[status.lastResult] ?? null : null;
}

export function ProjectCodeTab({ projectId, onOpenWorkspaces }: { projectId: string; onOpenWorkspaces?: () => void }) {
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [openPath, setOpenPath] = useState<string | null>(null);
  const statusQuery = useQuery({
    queryKey: queryKeys.projects.codeView(projectId),
    queryFn: () => projectCodeViewApi.list(projectId),
  });
  const workspaces = statusQuery.data?.workspaces ?? [];
  const selectedId = searchParams.get("workspace");
  const current = workspaces.find((workspace) => workspace.workspaceId === selectedId) ?? workspaces[0] ?? null;
  const currentId = current?.workspaceId ?? null;

  const refresh = useMutation({
    mutationFn: (input: { workspaceId: string; reason: "open" | "manual" }) =>
      projectCodeViewApi.refresh(projectId, input.workspaceId, input.reason),
    onSettled: () => Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.codeView(projectId) }),
      queryClient.invalidateQueries({ queryKey: ["projects", "code-files", projectId] }),
    ]),
  });

  // Pull the latest code once each time a workspace is shown; the server throttles repeats.
  const openedFor = useRef<string | null>(null);
  const { mutate } = refresh;
  useEffect(() => {
    if (!currentId || openedFor.current === currentId) return;
    openedFor.current = currentId;
    mutate({ workspaceId: currentId, reason: "open" });
  }, [currentId, mutate]);
  useEffect(() => setOpenPath(null), [currentId]);

  if (statusQuery.isLoading) return <p className="text-sm text-muted-foreground">Loading code…</p>;
  if (statusQuery.isError) {
    return <p className="text-sm text-destructive">{describeError(statusQuery.error, { action: "load the code view" }).body}</p>;
  }
  if (!current) {
    return (
      <div className="space-y-2 rounded-lg border border-border p-4 text-sm text-muted-foreground">
        <p>No local code copy is set up for this project. Add a local workspace and enable the code view on it.</p>
        {onOpenWorkspaces ? (
          <Button type="button" variant="outline" size="sm" onClick={onOpenWorkspaces}>Open workspaces</Button>
        ) : null}
      </div>
    );
  }

  const warning = warningFor(current);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {workspaces.length > 1 ? (
          <select
            aria-label="Code copy"
            className="rounded-md border border-border bg-background px-2 py-1 text-sm"
            value={current.workspaceId}
            onChange={(event) => {
              const next = new URLSearchParams(searchParams);
              next.set("workspace", event.target.value);
              setSearchParams(next, { replace: true });
            }}
          >
            {workspaces.map((workspace) => (
              <option key={workspace.workspaceId} value={workspace.workspaceId}>{workspace.workspaceName}</option>
            ))}
          </select>
        ) : (
          <span className="text-sm font-medium">{current.workspaceName}</span>
        )}
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground" title={headLine(current)}>
          {headLine(current)}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={refresh.isPending}
          onClick={() => refresh.mutate({ workspaceId: current.workspaceId, reason: "manual" })}
        >
          {refresh.isPending ? <Loader2 className="animate-spin" aria-hidden /> : <RefreshCcw aria-hidden />}
          {refresh.isPending ? "Updating…" : "Update"}
        </Button>
      </div>
      {warning ? <p className="text-xs text-muted-foreground">{warning}</p> : null}
      {refresh.isError ? (
        <p className="text-xs text-destructive">Update failed: {describeError(refresh.error, { action: "update the code" }).body}</p>
      ) : null}
      <div className="flex flex-col gap-3 lg:flex-row">
        <div className="h-160 min-h-0 lg:w-80 lg:shrink-0">
          <WorkspaceFileBrowser
            key={current.workspaceId}
            scope={{ kind: "project", projectId, workspaceId: current.workspaceId }}
            autoFocusSearch={false}
            selectedPath={openPath}
            onOpen={(ref) => setOpenPath(ref.path)}
            className="h-full"
          />
        </div>
        <div className="h-160 min-h-0 min-w-0 flex-1">
          {openPath ? (
            <ProjectCodeFilePanel projectId={projectId} workspaceId={current.workspaceId} path={openPath} />
          ) : (
            <div className="flex h-full items-center justify-center rounded-lg border border-dashed border-border text-sm text-muted-foreground">
              Select a file to read it.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
