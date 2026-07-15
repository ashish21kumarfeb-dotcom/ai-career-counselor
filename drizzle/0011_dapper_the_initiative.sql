CREATE TYPE "public"."run_status" AS ENUM('approved', 'corrected', 'regenerated', 'fallback', 'failed');--> statement-breakpoint
CREATE TABLE "agent_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"user_id" uuid,
	"query" text NOT NULL,
	"intent" varchar,
	"execution_plan" jsonb,
	"trace" jsonb,
	"final_status" "run_status" NOT NULL,
	"recommendation_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "agent_runs_run_id_unique" UNIQUE("run_id")
);
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_recommendation_id_ai_recommendations_id_fk" FOREIGN KEY ("recommendation_id") REFERENCES "public"."ai_recommendations"("id") ON DELETE no action ON UPDATE no action;