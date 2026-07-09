CREATE TYPE "public"."user_type" AS ENUM('student', 'fresher', 'working_professional', 'job_switcher');--> statement-breakpoint
CREATE TABLE "user_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"user_type" "user_type" NOT NULL,
	"education" varchar,
	"current_role" varchar,
	"skills" text,
	"interests" text,
	"career_goal" text,
	"location" varchar,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_profiles" ADD CONSTRAINT "user_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;