CREATE TABLE "agent_model_fallback_states" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"active_connection_id" text,
	"pinned_issue_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"switched_at" timestamp with time zone,
	"reason" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_account_exhaustions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"account_key" text NOT NULL,
	"exhausted_until" timestamp with time zone NOT NULL,
	"source_run_id" uuid,
	"parsed_reset_time" boolean NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_model_fallback_states" ADD CONSTRAINT "agent_model_fallback_states_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_model_fallback_states" ADD CONSTRAINT "agent_model_fallback_states_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_account_exhaustions" ADD CONSTRAINT "model_account_exhaustions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_account_exhaustions" ADD CONSTRAINT "model_account_exhaustions_source_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("source_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_model_fallback_states_company_agent_uq" ON "agent_model_fallback_states" USING btree ("company_id","agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "model_account_exhaustions_company_account_uq" ON "model_account_exhaustions" USING btree ("company_id","account_key");