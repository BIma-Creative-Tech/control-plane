CREATE TYPE "public"."subscription_lifecycle" AS ENUM('implementation', 'self_serve');--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "lifecycle" "subscription_lifecycle" DEFAULT 'implementation' NOT NULL;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "purge_due_at" date;