import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, companies, companyMemberships, createDb, projects, projectWorkspaces } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { errorHandler } from "../middleware/index.js";
import { projectCodeViewRoutes } from "../routes/project-code-view.js";
import { createProjectCodeViewService } from "../services/project-code-view/service.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

describePostgres("project code view routes", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let home: string;
  let clone: string;
  const userId = randomUUID();
  const companyId = randomUUID();
  const otherCompanyId = randomUUID();
  const projectId = randomUUID();
  const otherProjectId = randomUUID();
  let workspaceId = "";
  let plainWorkspaceId = "";
  let otherWorkspaceId = "";

  beforeAll(async () => {
    home = realpathSync(mkdtempSync(path.join(os.tmpdir(), "code-view-routes-")));
    vi.stubEnv("PAPERCLIP_HOME", path.join(home, "paperclip"));
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "code-view-routes");
    clone = path.join(home, "clone");
    mkdirSync(path.join(clone, "apps", "web"), { recursive: true });
    writeFileSync(path.join(clone, "apps", "web", "main.ts"), "export const main = 1;\n");
    writeFileSync(path.join(clone, "README.md"), "# Tutor booking\n");
    writeFileSync(path.join(clone, ".env"), "SECRET=1\n");
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: clone });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "add", "README.md", "apps"], { cwd: clone });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "init"], { cwd: clone });

    database = await startEmbeddedPostgresTestDatabase("paperclip-code-view-routes-");
    db = createDb(database.connectionString);
    await db.insert(companies).values([
      { id: companyId, name: "Code view", issuePrefix: "CVR" },
      { id: otherCompanyId, name: "Other", issuePrefix: "CVO" },
    ]);
    await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user", status: "active", membershipRole: "owner" });
    await db.insert(projects).values([
      { id: projectId, companyId, name: "Web" },
      { id: otherProjectId, companyId: otherCompanyId, name: "Elsewhere" },
    ]);
    const [flagged] = await db.insert(projectWorkspaces).values({
      companyId, projectId, name: "Codebase (local main)", sourceType: "local_path", cwd: clone, metadata: { codeView: { enabled: true } },
    }).returning();
    const [plain] = await db.insert(projectWorkspaces).values({
      companyId, projectId, name: "Plain", sourceType: "local_path", cwd: clone,
    }).returning();
    const [other] = await db.insert(projectWorkspaces).values({
      companyId: otherCompanyId, projectId: otherProjectId, name: "Other", sourceType: "local_path", cwd: clone, metadata: { codeView: { enabled: true } },
    }).returning();
    workspaceId = flagged!.id;
    plainWorkspaceId = plain!.id;
    otherWorkspaceId = other!.id;
  }, 90_000);

  afterAll(async () => {
    await database?.cleanup(); vi.unstubAllEnvs();
    if (home) rmSync(home, { recursive: true, force: true });
  });

  const git = {
    readCloneHead: async () => ({ branch: "main", head: "87d6557", subject: "init" }),
    refreshClone: async () => ({ result: "up_to_date" as const, before: "a".repeat(40), after: "a".repeat(40), error: null }),
  };

  const appFor = (actor: Record<string, unknown> = { type: "board", source: "session", userId, companyIds: [companyId], isInstanceAdmin: false }) => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.actor = actor as never; next(); });
    app.use("/api", projectCodeViewRoutes(db, { service: createProjectCodeViewService(db, { git }) }));
    app.use(errorHandler);
    return app;
  };
  const files = (id = workspaceId, project = projectId) => `/api/projects/${project}/workspaces/${id}/file-resources`;

  it("lists only the flagged workspaces of the project", async () => {
    const res = await request(appFor()).get(`/api/projects/${projectId}/code-view`).expect(200);
    expect(res.body.workspaces.map((w: { workspaceId: string }) => w.workspaceId)).toEqual([workspaceId]);
    expect(res.body.workspaces[0]).toMatchObject({ branch: "main", head: "87d6557" });
  });

  it("lists the workspace root in all mode", async () => {
    const res = await request(appFor()).get(`${files()}/list`).expect(200);
    expect(res.body.query.mode).toBe("all");
    const names = res.body.items.map((item: { title: string }) => item.title);
    expect(names).toEqual(expect.arrayContaining(["apps", "README.md"]));
  });

  it("lists a folder", async () => {
    const res = await request(appFor()).get(`${files()}/list`).query({ path: "apps" }).expect(200);
    expect(res.body.items.map((item: { title: string }) => item.title)).toEqual(["web"]);
  });

  it("reads a file and audits the read", async () => {
    const res = await request(appFor()).get(`${files()}/content`).query({ path: "README.md" }).expect(200);
    expect(res.body.content.data).toContain("# Tutor booking");
    const rows = await db.select().from(activityLog).where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, "project.code_file_content_read")));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ entityType: "project", entityId: projectId });
  });

  it("resolves a file", async () => {
    const res = await request(appFor()).get(`${files()}/resolve`).query({ path: "apps/web/main.ts" }).expect(200);
    expect(res.body).toMatchObject({ kind: "file", title: "main.ts" });
  });

  it("refuses paths outside the workspace and denied files", async () => {
    const outside = await request(appFor()).get(`${files()}/content`).query({ path: "../outside" });
    expect(outside.status).toBeGreaterThanOrEqual(400);
    expect(outside.status).toBeLessThan(500);
    const env = await request(appFor()).get(`${files()}/content`).query({ path: ".env" });
    expect(env.status).toBe(403);
    expect(JSON.stringify(env.body)).not.toContain("SECRET");
  });

  it("hides workspaces without the code view flag", async () => {
    await request(appFor()).get(`${files(plainWorkspaceId)}/list`).expect(404);
    await request(appFor()).get(`${files(plainWorkspaceId)}/content`).query({ path: "README.md" }).expect(404);
  });

  it("hides another company's project", async () => {
    await request(appFor()).get(`/api/projects/${otherProjectId}/code-view`).expect(404);
    await request(appFor()).get(`${files(otherWorkspaceId, otherProjectId)}/list`).expect(404);
    await request(appFor()).get(`${files(otherWorkspaceId, projectId)}/list`).expect(404);
  });

  it("denies agents", async () => {
    const agent = { type: "agent", agentId: randomUUID(), companyId, source: "api_key" };
    await request(appFor(agent)).get(`/api/projects/${projectId}/code-view`).expect(403);
    await request(appFor(agent)).get(`${files()}/list`).expect(403);
  });

  it("refreshes on demand and rejects a client-sent task_done reason", async () => {
    const refreshUrl = `/api/projects/${projectId}/workspaces/${workspaceId}/code-view/refresh`;
    const res = await request(appFor()).post(refreshUrl).send({ reason: "manual" }).expect(200);
    expect(res.body).toMatchObject({ workspaceId, lastResult: "up_to_date" });
    await request(appFor()).post(refreshUrl).send({ reason: "task_done" }).expect(400);
  });
});
