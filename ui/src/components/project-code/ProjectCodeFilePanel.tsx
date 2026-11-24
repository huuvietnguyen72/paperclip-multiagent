import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { projectCodeViewApi } from "@/api/project-code-view";
import { FilePreviewModeToggle } from "@/components/FilePreviewModeToggle";
import { FileViewerBody } from "@/components/FileViewerSheet";
import { Button } from "@/components/ui/button";
import { isCsvFile } from "@/lib/csv-preview";
import { isHtmlPreview } from "@/lib/html-preview";
import { queryKeys } from "@/lib/queryKeys";

/** One file of the project's code copy, rendered with the shared file viewer body. */
export function ProjectCodeFilePanel({ projectId, workspaceId, path }: { projectId: string; workspaceId: string; path: string }) {
  const [previewMode, setPreviewMode] = useState<"raw" | "rendered">("rendered");
  useEffect(() => setPreviewMode("rendered"), [path, workspaceId]);
  const [announcement, setAnnouncement] = useState("");
  const resourceQuery = useQuery({
    queryKey: queryKeys.projects.codeFile(projectId, workspaceId, path, "resolve"),
    queryFn: () => projectCodeViewApi.resolve(projectId, workspaceId, path),
    retry: false,
  });
  const resource = resourceQuery.data;
  const contentQuery = useQuery({
    queryKey: queryKeys.projects.codeFile(projectId, workspaceId, path, "content"),
    queryFn: () => projectCodeViewApi.content(projectId, workspaceId, path),
    enabled: resource?.capabilities.preview === true,
    retry: false,
  });
  const label = resource ? resource.displayPath || resource.title : path;
  const renderedPreview = resource && (isHtmlPreview(resource.contentType, label) || isCsvFile(label, resource.contentType ?? "")
    || /\.(md|markdown|mdown|mkdn|mkd)$/i.test(label) || resource.contentType?.includes("markdown"));

  return (
    <div className="flex h-full min-h-0 flex-col rounded-lg border border-border bg-muted/20">
      <header className="flex min-w-0 items-start gap-2 border-b border-border bg-card px-3 py-2">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-medium" title={path}>{resource?.title ?? path}</h2>
          <p className="truncate font-mono text-xs text-muted-foreground" title={path}>{path}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {renderedPreview && contentQuery.data ? <FilePreviewModeToggle mode={previewMode} onChange={setPreviewMode} label="File preview mode" /> : null}
          {resource?.capabilities.download ? (
            <Button asChild variant="ghost" size="icon-sm">
              <a href={projectCodeViewApi.downloadUrl(projectId, workspaceId, path)} download={resource.title} aria-label="Download file" title="Download file">
                <Download aria-hidden />
              </a>
            </Button>
          ) : null}
        </div>
      </header>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="sr-only" aria-live="polite">{announcement}</div>
        <FileViewerBody
          previewMode={previewMode}
          resolveQuery={resourceQuery}
          contentQuery={contentQuery}
          elapsedMs={0}
          canPreview={resource?.capabilities.preview ?? false}
          highlightedLine={null}
          onRetry={() => {
            void resourceQuery.refetch();
            if (resource?.capabilities.preview) void contentQuery.refetch();
          }}
          onSetAnnouncement={setAnnouncement}
          onFallbackToProject={null}
        />
      </div>
    </div>
  );
}
