import { pgTable, uuid, text, timestamp, boolean, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

export const modelAccountExhaustions = pgTable(
  "model_account_exhaustions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    accountKey: text("account_key").notNull(),
    exhaustedUntil: timestamp("exhausted_until", { withTimezone: true }).notNull(),
    sourceRunId: uuid("source_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    parsedResetTime: boolean("parsed_reset_time").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyAccountUniqueIdx: uniqueIndex("model_account_exhaustions_company_account_uq").on(
      table.companyId,
      table.accountKey,
    ),
  }),
);
