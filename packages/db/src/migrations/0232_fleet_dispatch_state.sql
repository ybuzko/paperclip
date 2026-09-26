CREATE TABLE "fleet_dispatch_state" (
	"project_id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"jira_project" text NOT NULL,
	"lead_agent_id" uuid NOT NULL,
	"dispatch_issue_id" uuid,
	"last_poll_at" timestamp with time zone,
	"ready_tasks" integer DEFAULT 0 NOT NULL,
	"epics_to_explode" integer DEFAULT 0 NOT NULL,
	"epics_to_close" integer DEFAULT 0 NOT NULL,
	"epic_keys_to_close" jsonb,
	"counts_fingerprint" text,
	"last_decision" jsonb,
	"last_nudge_at" timestamp with time zone,
	"last_nudge_wake_id" text,
	"backoff_level" integer DEFAULT 0 NOT NULL,
	"last_ack" jsonb,
	"last_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

--> statement-breakpoint
ALTER TABLE "fleet_dispatch_state" ADD CONSTRAINT "fleet_dispatch_state_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "fleet_dispatch_state" ADD CONSTRAINT "fleet_dispatch_state_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "fleet_dispatch_state" ADD CONSTRAINT "fleet_dispatch_state_lead_agent_id_agents_id_fk" FOREIGN KEY ("lead_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "fleet_dispatch_state" ADD CONSTRAINT "fleet_dispatch_state_dispatch_issue_id_issues_id_fk" FOREIGN KEY ("dispatch_issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "fleet_dispatch_state_company_idx" ON "fleet_dispatch_state" USING btree ("company_id");
