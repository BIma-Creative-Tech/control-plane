CREATE TYPE "public"."env_db_status" AS ENUM('absent', 'provisioned');--> statement-breakpoint
CREATE TYPE "public"."env_route_status" AS ENUM('absent', 'active', 'removed');--> statement-breakpoint
CREATE TYPE "public"."env_sso_status" AS ENUM('none', 'active', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."tenant_user_status" AS ENUM('pending', 'active', 'revoked', 'failed');--> statement-breakpoint
ALTER TYPE "public"."job_status" ADD VALUE 'dispatched' BEFORE 'running';--> statement-breakpoint
ALTER TYPE "public"."job_type" ADD VALUE 'odoo_db_provision';--> statement-breakpoint
ALTER TYPE "public"."job_type" ADD VALUE 'odoo_route';--> statement-breakpoint
ALTER TYPE "public"."job_type" ADD VALUE 'odoo_sso_provision';--> statement-breakpoint
ALTER TYPE "public"."job_type" ADD VALUE 'odoo_sso_disable';--> statement-breakpoint
ALTER TYPE "public"."job_type" ADD VALUE 'odoo_sso_user';--> statement-breakpoint
CREATE TABLE "tenant_user_access" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"environment_id" uuid NOT NULL,
	"email" text NOT NULL,
	"odoo_login" text,
	"is_tenant_admin" boolean DEFAULT false NOT NULL,
	"status" "tenant_user_status" DEFAULT 'pending' NOT NULL,
	"kc_user_id" uuid,
	"odoo_user_id" integer,
	"invited_by" uuid,
	"last_job_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_user_access_email_format" CHECK (length("tenant_user_access"."email") <= 254 AND "tenant_user_access"."email" = lower("tenant_user_access"."email") AND "tenant_user_access"."email" ~ '^[a-z0-9._%+-]+@([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$'),
	CONSTRAINT "tenant_user_access_login_format" CHECK ("tenant_user_access"."odoo_login" IS NULL OR "tenant_user_access"."odoo_login" ~ '^[A-Za-z0-9._@+][A-Za-z0-9._@+-]{0,253}$')
);
--> statement-breakpoint
ALTER TABLE "environments" ADD COLUMN "host" text;--> statement-breakpoint
ALTER TABLE "environments" ADD COLUMN "db_status" "env_db_status" DEFAULT 'absent' NOT NULL;--> statement-breakpoint
ALTER TABLE "environments" ADD COLUMN "route_status" "env_route_status" DEFAULT 'absent' NOT NULL;--> statement-breakpoint
ALTER TABLE "environments" ADD COLUMN "sso_status" "env_sso_status" DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "environments" ADD COLUMN "sso_client_id" text;--> statement-breakpoint
ALTER TABLE "environments" ADD COLUMN "sso_provider_id" integer;--> statement-breakpoint
ALTER TABLE "environments" ADD COLUMN "last_job_id" uuid;--> statement-breakpoint
ALTER TABLE "provision_jobs" ADD COLUMN "environment_id" uuid;--> statement-breakpoint
ALTER TABLE "provision_jobs" ADD COLUMN "env" "environment_kind";--> statement-breakpoint
ALTER TABLE "provision_jobs" ADD COLUMN "dry_run" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "provision_jobs" ADD COLUMN "exit_code" integer;--> statement-breakpoint
ALTER TABLE "provision_jobs" ADD COLUMN "error_code" text;--> statement-breakpoint
ALTER TABLE "provision_jobs" ADD COLUMN "result" jsonb;--> statement-breakpoint
ALTER TABLE "provision_jobs" ADD COLUMN "parent_job_id" uuid;--> statement-breakpoint
ALTER TABLE "provision_jobs" ADD COLUMN "dispatched_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "provision_jobs" ADD COLUMN "deadline_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tenant_user_access" ADD CONSTRAINT "tenant_user_access_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_user_access" ADD CONSTRAINT "tenant_user_access_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_user_access" ADD CONSTRAINT "tenant_user_access_last_job_id_provision_jobs_id_fk" FOREIGN KEY ("last_job_id") REFERENCES "public"."provision_jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_user_access_env_email_uq" ON "tenant_user_access" USING btree ("environment_id","email");--> statement-breakpoint
CREATE INDEX "tenant_user_access_email_idx" ON "tenant_user_access" USING btree ("email");--> statement-breakpoint
ALTER TABLE "environments" ADD CONSTRAINT "environments_last_job_id_provision_jobs_id_fk" FOREIGN KEY ("last_job_id") REFERENCES "public"."provision_jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provision_jobs" ADD CONSTRAINT "provision_jobs_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provision_jobs" ADD CONSTRAINT "provision_jobs_parent_job_id_provision_jobs_id_fk" FOREIGN KEY ("parent_job_id") REFERENCES "public"."provision_jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "provision_jobs_environment_idx" ON "provision_jobs" USING btree ("environment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "provision_jobs_one_active_uq" ON "provision_jobs" USING btree ("environment_id","type") WHERE "provision_jobs"."status" NOT IN ('succeeded', 'failed', 'cancelled');--> statement-breakpoint
ALTER TABLE "environments" ADD CONSTRAINT "environments_host_format" CHECK ("environments"."host" IS NULL OR (length("environments"."host") <= 253 AND "environments"."host" ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$'));--> statement-breakpoint
ALTER TABLE "environments" ADD CONSTRAINT "environments_sso_client_id_format" CHECK ("environments"."sso_client_id" IS NULL OR "environments"."sso_client_id" ~ '^[A-Za-z0-9._-]{1,128}$');--> statement-breakpoint
ALTER TABLE "provision_jobs" ADD CONSTRAINT "provision_jobs_error_code_valid" CHECK ("provision_jobs"."error_code" IS NULL OR "provision_jobs"."error_code" IN ('rejected_validation', 'rejected_quota', 'disabled', 'blocked_dry_run', 'locked', 'timeout_state_unknown', 'script_exit', 'no_result'));