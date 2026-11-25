import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { TEAM_FEED_DEFAULT_LIMIT } from "@paperclipai/shared";
import { issueReadSqlCondition } from "../services/authorization.js";
import { createTeamFeedService } from "../services/team-feed/index.js";
import { assertCompanyAccess } from "./authz.js";

/** Team feed: read-only list of task status changes with the agent's note and changed files. */
export function teamFeedRoutes(db: Db) {
  const router = Router();
  const service = createTeamFeedService(db);

  router.get("/companies/:companyId/team-feed", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const requested = Number(req.query.limit);
    res.json(await service.list({
      companyId,
      readCondition: await issueReadSqlCondition(db, req.actor),
      before: typeof req.query.before === "string" ? req.query.before : null,
      limit: Number.isFinite(requested) ? requested : TEAM_FEED_DEFAULT_LIMIT,
    }));
  });

  return router;
}
