import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Router, type Request } from "express";
import { projects, type Db } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { badRequest, notFound, unprocessable } from "../errors.js";
import { logActivity } from "../services/activity-log.js";
import { projectCodeViewServiceFor, type ProjectCodeViewService } from "../services/project-code-view/index.js";
import type { RemoteWorkspaceFiles } from "../services/remote-workspace-files.js";
import { workspaceFileResourceService, type ProjectWorkspaceFileTarget } from "../services/workspace-file-resources.js";
import { assertBoard, getActorInfo, hasCompanyAccess } from "./authz.js";
import {
  activityDetails,
  createFileResourceLimiter,
  createFileResourceListLimiter,
  denialReasonFromError,
  parseBooleanQuery,
  readListQuery,
  readQuery,
  requestAbortController,
  safeAttachmentFilename,
} from "./file-resources.js";

/**
 * Project "Code" tab: read-only browsing of a project workspace that opted in with
 * `metadata.codeView.enabled`, plus on-demand refresh of that local copy. Board only.
 */
export function projectCodeViewRoutes(db: Db, opts: {
  service?: ProjectCodeViewService;
  remoteFiles?: RemoteWorkspaceFiles;
} = {}) {
  const router = Router();
  const codeView = () => opts.service ?? projectCodeViewServiceFor(db);
  const filesFor = (req: Request) => workspaceFileResourceService(db, req.actor, { remoteFiles: opts.remoteFiles });
  const limiter = createFileResourceLimiter();
  const listLimiter = createFileResourceListLimiter();

  async function projectFor(req: Request) {
    assertBoard(req);
    const [project] = await db.select({ id: projects.id, companyId: projects.companyId }).from(projects)
      .where(eq(projects.id, req.params.projectId as string));
    // Same 404 for a missing project and another company's project.
    if (!project || !hasCompanyAccess(req, project.companyId)) throw notFound("Project not found");
    return project;
  }

  async function targetFor(req: Request): Promise<ProjectWorkspaceFileTarget> {
    const project = await projectFor(req);
    const workspace = await codeView().getEnabledWorkspace(project.companyId, project.id, req.params.workspaceId as string);
    if (!workspace) throw notFound("Project code view not found");
    return { companyId: project.companyId, projectId: project.id, workspaceId: workspace.id };
  }

  async function logContent(req: Request, target: ProjectWorkspaceFileTarget, action: string, details: Record<string, unknown>) {
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: target.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action,
      entityType: "project",
      entityId: target.projectId,
      agentId: actor.agentId,
      runId: actor.runId,
      details,
    });
  }

  const deniedDetails = (target: ProjectWorkspaceFileTarget, displayPath: string, error: unknown) => activityDetails({
    outcome: "denied", projectId: target.projectId, workspaceId: target.workspaceId, displayPath,
    denialReason: denialReasonFromError(error),
  });

  router.get("/projects/:projectId/code-view", async (req, res) => {
    const project = await projectFor(req);
    res.json({ workspaces: await codeView().listStatuses(project.companyId, project.id) });
  });

  router.post("/projects/:projectId/workspaces/:workspaceId/code-view/refresh", async (req, res) => {
    const reason = (req.body as { reason?: unknown } | undefined)?.reason;
    if (reason !== "open" && reason !== "manual") throw badRequest("reason must be \"open\" or \"manual\"");
    const target = await targetFor(req);
    const actor = getActorInfo(req);
    res.json(await codeView().refresh({
      ...target,
      reason,
      actor: { actorType: actor.actorType === "agent" ? "agent" : "user", actorId: actor.actorId },
    }));
  });

  router.get("/projects/:projectId/workspaces/:workspaceId/file-resources/list", async (req, res) => {
    const target = await targetFor(req);
    const actor = getActorInfo(req);
    const query = readListQuery(req.query);
    const release = listLimiter.acquire(`${target.companyId}:${actor.actorId}:${target.workspaceId}`);
    const requestAbort = requestAbortController(req, res);
    try {
      res.json(await filesFor(req).listForProjectWorkspace(target, {
        path: query.path, mode: query.mode, q: query.q, limit: query.limit, offset: query.offset,
      }, {
        scanContext: {
          signal: requestAbort.signal,
          fairnessKeys: [`company:${target.companyId}`, `actor:${actor.actorId}`, `project-workspace:${target.workspaceId}`],
        },
      }));
    } finally {
      requestAbort.cleanup();
      release();
    }
  });

  router.get("/projects/:projectId/workspaces/:workspaceId/file-resources/resolve", async (req, res) => {
    const target = await targetFor(req);
    const query = readQuery(req.query);
    const release = limiter.acquire(`${target.companyId}:${getActorInfo(req).actorId}:${target.workspaceId}`);
    try {
      res.json(await filesFor(req).resolveForProjectWorkspace(target, { path: query.path }));
    } catch (error) {
      await logContent(req, target, "project.code_file_resolve_denied", deniedDetails(target, query.path, error));
      throw error;
    } finally {
      release();
    }
  });

  router.get("/projects/:projectId/workspaces/:workspaceId/file-resources/content", async (req, res) => {
    const target = await targetFor(req);
    const query = readQuery(req.query);
    const release = limiter.acquire(`${target.companyId}:${getActorInfo(req).actorId}:${target.workspaceId}`);
    try {
      if (parseBooleanQuery(req.query.download)) {
        let result;
        try {
          result = await filesFor(req).prepareDownloadForProjectWorkspace(target, { path: query.path });
        } catch (error) {
          await logContent(req, target, "project.code_file_download_denied", deniedDetails(target, query.path, error));
          throw error;
        }
        try {
          await logContent(req, target, "project.code_file_download", activityDetails({
            outcome: "success", projectId: target.projectId, workspaceId: target.workspaceId,
            displayPath: result.resource.displayPath, byteSize: result.resource.byteSize ?? null,
            contentType: result.resource.contentType ?? null,
          }));
          res.setHeader("Content-Type", result.resource.contentType ?? "application/octet-stream");
          if (result.resource.byteSize != null) res.setHeader("Content-Length", String(result.resource.byteSize));
          res.setHeader("Cache-Control", "private, max-age=60");
          res.setHeader("X-Content-Type-Options", "nosniff");
          res.setHeader("Content-Disposition", `attachment; filename="${safeAttachmentFilename(result.resource.title)}"`);
          if ("stream" in result) await pipeline(result.stream, res);
          else await pipeline(createReadStream(result.realPath), res);
        } finally {
          if ("stream" in result) await result.cleanup();
        }
        return;
      }

      let result;
      try {
        result = await filesFor(req).readContentForProjectWorkspace(target, { path: query.path });
      } catch (error) {
        await logContent(req, target, "project.code_file_content_denied", deniedDetails(target, query.path, error));
        throw error;
      }
      if (!result) throw unprocessable("Workspace file cannot be previewed");
      await logContent(req, target, "project.code_file_content_read", activityDetails({
        outcome: "success", projectId: target.projectId, workspaceId: target.workspaceId,
        displayPath: result.resource.displayPath, byteSize: result.resource.byteSize ?? null,
        contentType: result.resource.contentType ?? null,
      }));
      res.set("X-Content-Type-Options", "nosniff");
      res.json(result);
    } finally {
      release();
    }
  });

  return router;
}
