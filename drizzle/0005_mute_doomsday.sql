CREATE TYPE "public"."verification_status" AS ENUM('pending', 'verified', 'rejected');--> statement-breakpoint
CREATE TABLE "consulting_agencies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar NOT NULL,
	"location" varchar,
	"services" text,
	"website" varchar,
	"verification_status" "verification_status" DEFAULT 'pending' NOT NULL,
	"source_url" varchar,
	"last_verified" timestamp
);
