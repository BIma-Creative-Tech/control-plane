CREATE TYPE "public"."tenant_isolation" AS ENUM('shared', 'dedicated');--> statement-breakpoint
CREATE TYPE "public"."tenant_status" AS ENUM('active', 'suspended', 'terminated');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('invited', 'active', 'disabled');--> statement-breakpoint
ALTER TYPE "public"."job_type" ADD VALUE 'kc_realm_sync';--> statement-breakpoint
ALTER TYPE "public"."job_type" ADD VALUE 'kc_org_ensure';--> statement-breakpoint
ALTER TYPE "public"."job_type" ADD VALUE 'kc_user_ensure';--> statement-breakpoint
ALTER TYPE "public"."job_type" ADD VALUE 'kc_user_set_roles';--> statement-breakpoint
ALTER TYPE "public"."job_type" ADD VALUE 'kc_user_set_enabled';--> statement-breakpoint
ALTER TYPE "public"."job_type" ADD VALUE 'kc_user_action_email';--> statement-breakpoint
ALTER TYPE "public"."job_type" ADD VALUE 'odoo_user_ensure';--> statement-breakpoint
ALTER TYPE "public"."job_type" ADD VALUE 'odoo_tenant_config';--> statement-breakpoint
ALTER TYPE "public"."job_type" ADD VALUE 'tenant_suspend';--> statement-breakpoint
ALTER TYPE "public"."job_type" ADD VALUE 'tenant_resume';--> statement-breakpoint
ALTER TABLE "provision_jobs" DROP CONSTRAINT "provision_jobs_error_code_valid";--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "status" "tenant_status" DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "isolation" "tenant_isolation" DEFAULT 'shared' NOT NULL;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "brand" text;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "kc_org_id" text;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "is_platform" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "provision_jobs" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "provision_jobs" ADD COLUMN "after_job_id" uuid;--> statement-breakpoint
ALTER TABLE "provision_jobs" ADD COLUMN "chain_id" uuid;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "status" "user_status" DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "invited_by" uuid;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "disabled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "provision_jobs" ADD CONSTRAINT "provision_jobs_after_job_id_provision_jobs_id_fk" FOREIGN KEY ("after_job_id") REFERENCES "public"."provision_jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "clients_one_platform_uq" ON "clients" USING btree ("is_platform") WHERE "clients"."is_platform";--> statement-breakpoint
CREATE UNIQUE INDEX "provision_jobs_idempotency_key_uq" ON "provision_jobs" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "provision_jobs_after_job_idx" ON "provision_jobs" USING btree ("after_job_id");--> statement-breakpoint
CREATE INDEX "provision_jobs_chain_idx" ON "provision_jobs" USING btree ("chain_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_one_tenant_admin_uq" ON "users" USING btree ("client_id") WHERE "users"."role" = 'client_admin' AND "users"."status" IN ('invited', 'active');--> statement-breakpoint
ALTER TABLE "provision_jobs" ADD CONSTRAINT "provision_jobs_error_code_valid" CHECK ("provision_jobs"."error_code" IS NULL OR "provision_jobs"."error_code" IN ('rejected_validation', 'rejected_quota', 'disabled', 'blocked_dry_run', 'locked', 'timeout_state_unknown', 'script_exit', 'no_result', 'spool_error', 'result_inconsistent', 'chain_aborted'));