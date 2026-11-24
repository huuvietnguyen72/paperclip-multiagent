import { issues, type Db } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { logger } from "../../middleware/logger.js";
import { subscribeAllCompanyLiveEvents } from "../live-events.js";
import type { ProjectCodeViewService } from "./service.js";

/**
 * Keeps the project "Code" tab current: when a task moves to done, refresh the code view
 * workspaces of its project. Fire-and-forget; it never affects the issue update itself.
 */
export function registerProjectCodeViewRefresh(service: Pick<ProjectCodeViewService, "refreshProject">, db: Db) {
  const onDone = async (companyId: string, issueId: string) => {
    const [issue] = await db.select({ projectId: issues.projectId }).from(issues)
      .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)));
    if (issue?.projectId) await service.refreshProject(companyId, issue.projectId, "task_done");
  };
  const unsubscribe = subscribeAllCompanyLiveEvents((event) => {
    if (event.type !== "activity.logged") return;
    const payload = event.payload as Record<string, unknown>;
    const details = payload.details as Record<string, unknown> | null | undefined;
    if (payload.entityType !== "issue" || payload.action !== "issue.updated" || details?.status !== "done") return;
    if (typeof payload.entityId !== "string") return;
    onDone(event.companyId, payload.entityId).catch((error) => {
      logger.warn({ err: error, issueId: payload.entityId }, "project code view refresh after task done failed");
    });
  });
  return { stop: () => unsubscribe() };
}
