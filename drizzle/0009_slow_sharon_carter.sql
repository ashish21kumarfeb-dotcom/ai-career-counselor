ALTER TYPE "public"."user_type" ADD VALUE 'parent_guardian';--> statement-breakpoint
ALTER TABLE "user_profiles" ADD COLUMN "details" jsonb;