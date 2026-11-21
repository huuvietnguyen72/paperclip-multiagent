CREATE TABLE "heartbeat_run_change_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_change_id" uuid NOT NULL,
	"path" text NOT NULL,
	"patch" text
);
--> statement-breakpoint
CREATE TABLE "heartbeat_run_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"issue_id" uuid,
	"agent_id" uuid NOT NULL,
	"execution_workspace_id" uuid,
	"cwd" text,
	"status" text NOT NULL,
	"reason" text,
	"start_head" text,
	"start_tree" text,
	"start_branch" text,
	"end_head" text,
	"end_tree" text,
	"end_branch" text,
	"additions" integer DEFAULT 0 NOT NULL,
	"deletions" integer DEFAULT 0 NOT NULL,
	"files" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"commands" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"overlapping_run_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finalized_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "heartbeat_run_change_files" ADD CONSTRAINT "heartbeat_run_change_files_run_change_id_heartbeat_run_changes_id_fk" FOREIGN KEY ("run_change_id") REFERENCES "public"."heartbeat_run_changes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "heartbeat_run_changes" ADD CONSTRAINT "heartbeat_run_changes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "heartbeat_run_changes" ADD CONSTRAINT "heartbeat_run_changes_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "heartbeat_run_changes" ADD CONSTRAINT "heartbeat_run_changes_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "heartbeat_run_changes" ADD CONSTRAINT "heartbeat_run_changes_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "heartbeat_run_changes" ADD CONSTRAINT "heartbeat_run_changes_execution_workspace_id_execution_workspaces_id_fk" FOREIGN KEY ("execution_workspace_id") REFERENCES "public"."execution_workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "heartbeat_run_change_files_run_change_path_idx" ON "heartbeat_run_change_files" USING btree ("run_change_id","path");--> statement-breakpoint
CREATE UNIQUE INDEX "heartbeat_run_changes_run_idx" ON "heartbeat_run_changes" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "heartbeat_run_changes_company_issue_created_idx" ON "heartbeat_run_changes" USING btree ("company_id","issue_id","created_at");--> statement-breakpoint
CREATE INDEX "heartbeat_run_changes_workspace_status_idx" ON "heartbeat_run_changes" USING btree ("execution_workspace_id","status");