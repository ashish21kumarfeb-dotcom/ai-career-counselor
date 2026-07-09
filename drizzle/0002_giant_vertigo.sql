CREATE TABLE "ai_recommendations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"query" text NOT NULL,
	"intent" varchar,
	"final_answer" text,
	"sources_used" jsonb,
	"evaluation_score" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_recommendations" ADD CONSTRAINT "ai_recommendations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;