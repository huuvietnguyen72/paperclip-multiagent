import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { RunChangeCommand, RunChangeFile } from "@paperclipai/shared";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { executionWorkspaces } from "./execution_workspaces.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { issues } from "./issues.js";

/** One row per agent run: the git snapshots around it and the changes between them. */
export const heartbeatRunChanges = pgTable(
  "heartbeat_run_changes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    runId: uuid("run_id").notNull().references(() => heartbeatRuns.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "set null" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id),
    executionWorkspaceId: uuid("execution_workspace_id")
      .references(() => executionWorkspaces.id, { onDelete: "set null" }),
    cwd: text("cwd"),
    status: text("status").notNull(),
    reason: text("reason"),
    startHead: text("start_head"),
    startTree: text("start_tree"),
    startBranch: text("start_branch"),
    endHead: text("end_head"),
    endTree: text("end_tree"),
    endBranch: text("end_branch"),
    additions: integer("additions").notNull().default(0),
    deletions: integer("deletions").notNull().default(0),
    files: jsonb("files").$type<RunChangeFile[]>().notNull().default([]),
    commands: jsonb("commands").$type<RunChangeCommand[]>().notNull().default([]),
    overlappingRunIds: jsonb("overlapping_run_ids").$type<string[]>().notNull().default([]),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finalizedAt: timestamp("finalized_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    runUniqueIdx: uniqueIndex("heartbeat_run_changes_run_idx").on(table.runId),
    companyIssueCreatedIdx: index("heartbeat_run_changes_company_issue_created_idx").on(
      table.companyId,
      table.issueId,
      table.createdAt,
    ),
    workspaceStatusIdx: index("heartbeat_run_changes_workspace_status_idx").on(
      table.executionWorkspaceId,
      table.status,
    ),
  }),
);

/** Bounded unified patch text for one changed file of a run. */
export const heartbeatRunChangeFiles = pgTable(
  "heartbeat_run_change_files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runChangeId: uuid("run_change_id")
      .notNull()
      .references(() => heartbeatRunChanges.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    patch: text("patch"),
  },
  (table) => ({
    runChangePathIdx: uniqueIndex("heartbeat_run_change_files_run_change_path_idx").on(
      table.runChangeId,
      table.path,
    ),
  }),
);
