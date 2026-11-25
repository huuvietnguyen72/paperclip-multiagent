import { useEffect } from "react";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight } from "lucide-react";
import { TEAM_FEED_PENDING_POLL_MS, type TeamFeedItem } from "@paperclipai/shared";
import { describeError } from "@/api/errors";
import { teamFeedApi } from "@/api/team-feed";
import { AgentAvatar } from "@/components/AgentAvatar";
import { StatusBadge } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";
import { useCompanyLiveEvent } from "@/context/LiveUpdatesProvider";
import { Link } from "@/lib/router";
import { queryKeys } from "@/lib/queryKeys";
import { timeAgo } from "@/lib/timeAgo";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";

/**
 * Team feed: a read-only, chat-like list of task status changes. Each message says who moved which task,
 * what the agent noted and which files the work changed. Acting on it is the CEO's and PM's job.
 */

const TERMINAL_RUN_STATUSES = new Set(["succeeded", "failed", "cancelled", "timed_out"]);

function taskHref(item: TeamFeedItem) {
  return `/issues/${item.issue.identifier ?? item.issue.id}`;
}

function ActorMark({ actor }: { actor: TeamFeedItem["actor"] }) {
  if (actor.kind === "agent") return <AgentAvatar agent={{ id: actor.agentId ?? undefined, name: actor.name }} size={32} />;
  return (
    <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium text-muted-foreground">
      {actor.name.slice(0, 1)}
    </span>
  );
}

function FeedChanges({ item }: { item: TeamFeedItem }) {
  const changes = item.changes;
  if (!changes) return null;
  const more = changes.totalFiles - changes.files.length;
  return (
    <div className="mt-2 space-y-0.5 rounded-md border border-border/60 bg-muted/20 px-2 py-1.5 font-mono text-xs">
      {changes.files.map((file) => (
        <div key={file.path} className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate" title={file.path}>{file.path}</span>
          {file.binary ? <span className="shrink-0 text-muted-foreground">binary</span> : (
            <span className="shrink-0">
              <span className="text-green-600 dark:text-green-400">+{file.additions}</span>{" "}
              <span className="text-red-600 dark:text-red-400">−{file.deletions}</span>
            </span>
          )}
        </div>
      ))}
      {changes.pending ? <p className="text-muted-foreground">Changes are still being recorded…</p> : null}
      {more > 0 || changes.files.length > 0 ? (
        <p className="text-muted-foreground">
          {more > 0 ? `… ${more} more files · ` : ""}
          <Link to={taskHref(item)} className="underline-offset-2 hover:underline">View changes</Link>
        </p>
      ) : null}
    </div>
  );
}

function FeedMessage({ item }: { item: TeamFeedItem }) {
  return (
    <li className="flex gap-3 rounded-lg border border-border bg-card px-3 py-2.5">
      <ActorMark actor={item.actor} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <span className="font-medium">{item.actor.name}</span>
          <Link to={taskHref(item)} className="min-w-0 truncate hover:underline">
            <span className="font-mono text-xs text-muted-foreground">{item.issue.identifier}</span> {item.issue.title}
          </Link>
          <span className="flex items-center gap-1">
            {item.fromStatus ? <span data-from-status={item.fromStatus}><StatusBadge status={item.fromStatus} /></span> : null}
            <ArrowRight className="size-3 text-muted-foreground" aria-hidden />
            <span data-to-status={item.toStatus}><StatusBadge status={item.toStatus} /></span>
          </span>
          <time className="ml-auto text-xs text-muted-foreground" dateTime={item.at} title={new Date(item.at).toLocaleString()}>
            {timeAgo(item.at)}
          </time>
        </div>
        {item.reason ? <p className="mt-0.5 font-mono text-xs text-muted-foreground">{item.reason}</p> : null}
        {item.note ? <p className="mt-1 text-sm text-muted-foreground">{item.note}</p> : null}
        <FeedChanges item={item} />
      </div>
    </li>
  );
}

export function TeamFeed() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  useEffect(() => { setBreadcrumbs([{ label: "Team feed" }]); }, [setBreadcrumbs]);

  const companyId = selectedCompanyId ?? "";
  const query = useInfiniteQuery({
    queryKey: queryKeys.teamFeed(companyId),
    queryFn: ({ pageParam }) => teamFeedApi.list(companyId, { before: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    enabled: Boolean(selectedCompanyId),
    refetchInterval: (state) =>
      state.state.data?.pages.some((page) => page.items.some((item) => item.changes?.pending)) ? TEAM_FEED_PENDING_POLL_MS : false,
  });

  useCompanyLiveEvent((event) => {
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    const details = payload.details as Record<string, unknown> | null | undefined;
    const statusChange = event.type === "activity.logged" && payload.entityType === "issue" && Boolean(details?.status);
    const runEnded = event.type === "heartbeat.run.status" && TERMINAL_RUN_STATUSES.has(String(payload.status));
    if (statusChange || runEnded) void queryClient.invalidateQueries({ queryKey: queryKeys.teamFeed(companyId) });
  });

  const items = query.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <div className="mx-auto max-w-3xl space-y-3">
      <div>
        <h1 className="text-lg font-semibold">Team feed</h1>
        <p className="text-sm text-muted-foreground">Every task status change, with the agent's note and the files the work changed.</p>
      </div>
      {query.isLoading ? <p className="text-sm text-muted-foreground">Loading team feed…</p> : null}
      {query.isError ? (
        <p className="text-sm text-destructive">{describeError(query.error, { action: "load the team feed" }).body}</p>
      ) : null}
      {query.isSuccess && items.length === 0 ? <p className="text-sm text-muted-foreground">No task updates yet.</p> : null}
      {items.length > 0 ? (
        <ul className="space-y-2">
          {items.map((item) => <FeedMessage key={item.id} item={item} />)}
        </ul>
      ) : null}
      {query.hasNextPage ? (
        <Button type="button" variant="outline" size="sm" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
          {query.isFetchingNextPage ? "Loading…" : "Load older"}
        </Button>
      ) : null}
    </div>
  );
}
