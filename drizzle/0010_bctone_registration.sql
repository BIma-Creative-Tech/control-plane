CREATE TYPE "public"."bctone_registration_status" AS ENUM('draft', 'verified', 'review', 'waitlist', 'provisioning', 'done', 'rejected', 'failed');--> statement-breakpoint
CREATE TABLE "bctone_registrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status" "bctone_registration_status" DEFAULT 'draft' NOT NULL,
	"email" text NOT NULL,
	"owner_name" text NOT NULL,
	"business_name" text NOT NULL,
	"slug" text NOT NULL,
	"industry" text,
	"outlets" integer,
	"modules" jsonb,
	"extra_needs" text,
	"tier" text,
	"ai_consent" "ai_consent",
	"otp_hash" text,
	"otp_salt" text,
	"otp_expires_at" timestamp with time zone,
	"otp_attempts" integer DEFAULT 0 NOT NULL,
	"otp_sends" integer DEFAULT 0 NOT NULL,
	"verified_at" timestamp with time zone,
	"submitted_at" timestamp with time zone,
	"ip" "inet",
	"client_id" uuid,
	"chain_id" uuid,
	"review_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bctone_reg_slug_format" CHECK ("bctone_registrations"."slug" ~ '^[a-z0-9-]{3,30}$'),
	CONSTRAINT "bctone_reg_tier" CHECK ("bctone_registrations"."tier" IS NULL OR "bctone_registrations"."tier" IN ('free','umkm','bisnis')),
	CONSTRAINT "bctone_reg_industry" CHECK ("bctone_registrations"."industry" IS NULL OR "bctone_registrations"."industry" IN ('fnb','retail'))
);
--> statement-breakpoint
ALTER TABLE "bctone_registrations" ADD CONSTRAINT "bctone_registrations_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bctone_reg_email_idx" ON "bctone_registrations" USING btree ("email","created_at");--> statement-breakpoint
CREATE INDEX "bctone_reg_ip_idx" ON "bctone_registrations" USING btree ("ip","created_at");--> statement-breakpoint
CREATE INDEX "bctone_reg_status_idx" ON "bctone_registrations" USING btree ("status","created_at");