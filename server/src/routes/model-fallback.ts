import { Router } from "express";
import { forbidden } from "../errors.js";
import { accessService } from "../services/access.js";
import { agentService } from "../services/agents.js";
import { createModelFallbackService } from "../services/model-fallback/service.js";
import type { Db } from "@paperclipai/db";
import { assertAuthenticated, assertCompanyAccess, getAccessibleResource } from "./authz.js";

export function modelFallbackRoutes(db: Db) {
  const router = Router();
  const agents = agentService(db);
  const access = accessService(db);
  const fallback = createModelFallbackService(db);

  router.get("/agents/:id/model-fallback", async (req, res) => {
    assertAuthenticated(req);
    const agent = await getAccessibleResource(req, res, agents.getById(req.params.id as string), "Agent not found");
    if (!agent) return;
    const decision = await access.decide({
      actor: req.actor,
      action: "agent:read",
      resource: { type: "agent", companyId: agent.companyId, agentId: agent.id },
    });
    if (!decision.allowed) throw forbidden("Agent is outside this actor's authorization boundary");
    res.json(await fallback.readAgentView({
      companyId: agent.companyId,
      agentId: agent.id,
      userId: req.actor.type === "board" ? req.actor.userId ?? null : null,
    }));
  });

  router.get("/companies/:companyId/model-fallback/active", async (req, res) => {
    assertAuthenticated(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await fallback.readCompanyActive(companyId));
  });

  return router;
}
