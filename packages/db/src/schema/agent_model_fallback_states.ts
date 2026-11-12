import { pgTable, uuid, text, timestamp, jsonb, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

export const agentModelFallbackStates = pgTable(
  "agent_model_fallback_states",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    activeConnectionId: text("active_connection_id"),
    pinnedIssueIds: jsonb("pinned_issue_ids").$type<string[]>().notNull().default([]),
    switchedAt: timestamp("switched_at", { withTimezone: true }),
    reason: text("reason"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyAgentUniqueIdx: uniqueIndex("agent_model_fallback_states_company_agent_uq").on(
      table.companyId,
      table.agentId,
    ),
  }),
);
