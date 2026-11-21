import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, TerminalSquare } from "lucide-react";
import type { IssueRunChangesEntry, RunChangeFile } from "@paperclipai/shared";
import { issuesApi } from "@/api/issues";
import { queryKeys } from "@/lib/queryKeys";
import { foldContext, parseUnifiedPatch, type PatchLine } from "@/lib/unified-patch";
import { cn } from "@/lib/utils";

/**
 * "Changes" tab: per agent run, the files it changed (red/green unified diff)
 * and the commands it ran. Data comes from git snapshots taken around each run.
 */

const STATUS_LETTER: Record<RunChangeFile["status"], string> = { added: "A", modified: "M", deleted: "D", renamed: "R" };

const LINE_CLASSES: Record<PatchLine["kind"], string> = {
  context: "bg-transparent",
  del: "bg-red-500/10 text-red-900 dark:text-red-100",
  add: "bg-green-500/10 text-green-900 dark:text-green-100",
};
const LINE_MARKER: Record<PatchLine["kind"], string> = { context: " ", del: "−", add: "+" };

const REASON_TEXT: Record<string, string> = {
  not_git: "Not captured: the workspace is not a git repository.",
  remote: "Not captured: the run used a remote workspace.",
  timeout: "Not captured: the git snapshot timed out.",
  workspace_missing: "Incomplete: the workspace was removed before the run finished.",
  missing_start_snapshot: "Incomplete: the start snapshot is missing.",
  finalize_error: "Could not compute the changes for this run.",
};

function Totals({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className="shrink-0 font-mono text-xs">
      <span className="text-green-600 dark:text-green-400">+{additions}</span>{" "}
      <span className="text-red-600 dark:text-red-400">−{deletions}</span>
    </span>
  );
}

function formatTime(value: string | null): string {
  return value ? new Date(value).toLocaleString() : "";
}

function FileDiff({ issueId, runId, file }: { issueId: string; runId: string; file: RunChangeFile }) {
  const query = useQuery({
    queryKey: queryKeys.issues.runChangeFile(issueId, runId, file.path),
    queryFn: () => issuesApi.getRunChangeFile(issueId, runId, file.path),
  });
  if (query.isLoading) return <p className="px-3 py-2 text-xs text-muted-foreground">Loading diff…</p>;
  if (query.isError || !query.data) return <p className="px-3 py-2 text-xs text-destructive">Could not load this diff.</p>;
  if (query.data.binary) return <p className="px-3 py-2 text-xs text-muted-foreground">Binary file, no preview.</p>;
  if (query.data.patch === null) return <p className="px-3 py-2 text-xs text-muted-foreground">No diff stored for this file (size limit reached).</p>;
  const hunks = parseUnifiedPatch(query.data.patch);
  return (
    <div className="overflow-x-auto border-t border-border/60 font-mono text-xs leading-5">
      {hunks.map((hunk, hunkIndex) => (
        <div key={`${hunk.header}-${hunkIndex}`}>
          <div className="bg-muted/40 px-3 py-1 text-muted-foreground">{hunk.header}</div>
          {foldContext(hunk.lines).map((row, rowIndex) =>
            "folded" in row ? (
              <div key={`fold-${rowIndex}`} className="bg-muted/20 px-3 py-0.5 text-center text-muted-foreground">
                … {row.folded} unchanged lines
              </div>
            ) : (
              <div key={`${row.kind}-${row.oldNo ?? "x"}-${row.newNo ?? "x"}-${rowIndex}`} data-line-kind={row.kind} className={cn("flex", LINE_CLASSES[row.kind])}>
                <span className="w-10 shrink-0 select-none pr-2 text-right text-muted-foreground">{row.oldNo ?? ""}</span>
                <span className="w-10 shrink-0 select-none pr-2 text-right text-muted-foreground">{row.newNo ?? ""}</span>
                <span className="w-4 shrink-0 select-none text-center text-muted-foreground">{LINE_MARKER[row.kind]}</span>
                <pre className="m-0 whitespace-pre-wrap break-all pr-3">{row.text.length > 0 ? row.text : " "}</pre>
              </div>
            ),
          )}
        </div>
      ))}
      {query.data.truncated ? (
        <p className="px-3 py-1 text-muted-foreground">Diff truncated: the file change is larger than the stored limit.</p>
      ) : null}
    </div>
  );
}

function FileRow({ issueId, runId, file }: { issueId: string; runId: string; file: RunChangeFile }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="rounded-md border border-border/60">
      <button
        type="button"
        data-file-path={file.path}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs hover:bg-muted/40"
      >
        {open ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" />}
        <span className="w-4 shrink-0 font-mono text-muted-foreground">{STATUS_LETTER[file.status]}</span>
        <span className="min-w-0 flex-1 truncate font-mono" title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}>
          {file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
        </span>
        {file.collapsedByDefault && !open ? <span className="shrink-0 text-muted-foreground">collapsed</span> : null}
        {file.binary ? <span className="shrink-0 text-muted-foreground">binary</span> : <Totals additions={file.additions} deletions={file.deletions} />}
      </button>
      {open ? <FileDiff issueId={issueId} runId={runId} file={file} /> : null}
    </li>
  );
}

function RunSection({ issueId, entry, defaultOpen }: { issueId: string; entry: IssueRunChangesEntry; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const [commandsOpen, setCommandsOpen] = useState(false);
  const reason = entry.status === "pending"
    ? "Run in progress. Changes appear when it finishes."
    : entry.status === "captured" ? null : REASON_TEXT[entry.reason ?? ""] ?? entry.reason;
  return (
    <section className="rounded-lg border border-border">
      <button
        type="button"
        data-run-id={entry.runId}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted/40"
      >
        {open ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
        <span className="min-w-0 flex-1 truncate">
          <span className="font-medium">{entry.agentName}</span>
          <span className="text-muted-foreground"> · {formatTime(entry.startedAt)} · {entry.runStatus} · {entry.files.length} files</span>
        </span>
        <Totals additions={entry.additions} deletions={entry.deletions} />
      </button>
      {reason ? <p className="border-t border-border px-3 py-1.5 text-xs text-muted-foreground">{reason}</p> : null}
      {open ? (
        <div className="space-y-2 border-t border-border px-3 py-2">
          {entry.overlappingRunIds.length > 0 ? (
            <p className="text-xs text-muted-foreground">Another run worked in the same workspace at the same time; this diff may include changes from another run.</p>
          ) : null}
          {entry.branchChanged ? (
            <p className="text-xs text-muted-foreground">The agent switched branches during this run; the diff may include differences between the two branches.</p>
          ) : null}
          {entry.commands.length > 0 ? (
            <div>
              <button type="button" onClick={() => setCommandsOpen((value) => !value)} className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
                <TerminalSquare className="h-3.5 w-3.5" />
                Commands run ({entry.commands.length})
              </button>
              {commandsOpen ? (
                <ol className="mt-1 space-y-1">
                  {entry.commands.map((command, index) => (
                    <li key={index} className="rounded bg-muted/40 px-2 py-1 font-mono text-xs">
                      <span className="text-muted-foreground">{command.tool} › </span>
                      <span className="whitespace-pre-wrap break-all">{command.text}</span>
                    </li>
                  ))}
                </ol>
              ) : null}
            </div>
          ) : null}
          {entry.files.length > 0 ? (
            <ul className="space-y-1">
              {entry.files.map((file) => <FileRow key={file.path} issueId={issueId} runId={entry.runId} file={file} />)}
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

export function TaskRunChangesPanel({ issueId }: { issueId: string }) {
  const query = useQuery({
    queryKey: queryKeys.issues.runChanges(issueId),
    queryFn: () => issuesApi.listRunChanges(issueId),
  });
  if (query.isLoading) return <p className="text-sm text-muted-foreground">Loading changes…</p>;
  if (query.isError) return <p className="text-sm text-destructive">Could not load the changes for this task.</p>;
  const entries = query.data ?? [];
  const shown = entries.filter((entry) => entry.status !== "no_changes");
  const withoutChanges = entries.length - shown.length;
  if (entries.length === 0) {
    return <p className="text-sm text-muted-foreground">No code changes recorded for this task yet. Each agent run that edits files in a git workspace appears here.</p>;
  }
  const firstCaptured = shown.find((entry) => entry.status === "captured")?.runId;
  return (
    <div className="space-y-2">
      {shown.map((entry) => (
        <RunSection key={entry.runId} issueId={issueId} entry={entry} defaultOpen={entry.runId === firstCaptured} />
      ))}
      {withoutChanges > 0 ? (
        <p className="px-1 text-xs text-muted-foreground">{withoutChanges} {withoutChanges === 1 ? "run" : "runs"} without code changes</p>
      ) : null}
    </div>
  );
}
