CREATE TYPE "public"."domain_purpose" AS ENUM('odoo', 'web', 'mail', 'insight', 'sso');--> statement-breakpoint
CREATE TYPE "public"."invoice_kind" AS ENUM('implementation', 'maintenance');--> statement-breakpoint
CREATE TYPE "public"."plan_service" AS ENUM('odoo', 'insight', 'mail', 'web');--> statement-breakpoint
ALTER TYPE "public"."subscription_status" ADD VALUE 'implementation';--> statement-breakpoint
ALTER TYPE "public"."subscription_status" ADD VALUE 'warranty';--> statement-breakpoint
ALTER TYPE "public"."subscription_status" ADD VALUE 'past_due';--> statement-breakpoint
CREATE TABLE "notification_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"kind" text NOT NULL,
	"subscription_id" uuid,
	"client_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"recipient_count" integer DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	CONSTRAINT "notification_log_status_valid" CHECK ("notification_log"."status" IN ('pending', 'sent', 'failed')),
	CONSTRAINT "notification_log_key_format" CHECK ("notification_log"."key" ~ '^[a-z0-9_:./-]{3,200}$')
);
--> statement-breakpoint
ALTER TABLE "audit_logs" DROP CONSTRAINT "audit_logs_actor_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "provision_jobs" DROP CONSTRAINT "provision_jobs_actor_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "plans" ALTER COLUMN "price_amount" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "domains" ADD COLUMN "purpose" "domain_purpose";--> statement-breakpoint
ALTER TABLE "domains" ADD COLUMN "dkim_txt" text;--> statement-breakpoint
ALTER TABLE "domains" ADD COLUMN "last_check" jsonb;--> statement-breakpoint
ALTER TABLE "environments" ADD COLUMN "tenant_check" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "kind" "invoice_kind" DEFAULT 'maintenance' NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "proof_reference" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "period_start" date;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "period_end" date;--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN "service" "plan_service";--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "go_live_at" date;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "warranty_until" date;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "notes" text;--> statement-breakpoint
ALTER TABLE "notification_log" ADD CONSTRAINT "notification_log_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_log" ADD CONSTRAINT "notification_log_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "notification_log_key_uq" ON "notification_log" USING btree ("key");--> statement-breakpoint
CREATE INDEX "notification_log_subscription_idx" ON "notification_log" USING btree ("subscription_id");--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provision_jobs" ADD CONSTRAINT "provision_jobs_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_maintenance_period_uq" ON "invoices" USING btree ("subscription_id","period_start") WHERE "invoices"."kind" = 'maintenance' AND "invoices"."status" <> 'void' AND "invoices"."period_start" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "environments" ADD CONSTRAINT "environments_tenant_check_valid" CHECK ("environments"."tenant_check" IS NULL OR "environments"."tenant_check" IN ('off', 'compat', 'strict'));--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_period_order" CHECK ("invoices"."period_start" IS NULL OR ("invoices"."period_end" IS NOT NULL AND "invoices"."period_end" > "invoices"."period_start"));