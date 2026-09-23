CREATE TYPE "public"."domain_status" AS ENUM('pending_dns', 'verified', 'active', 'failed');--> statement-breakpoint
CREATE TYPE "public"."environment_kind" AS ENUM('prod', 'demo', 'staging');--> statement-breakpoint
CREATE TYPE "public"."invoice_status" AS ENUM('unpaid', 'awaiting_confirmation', 'paid', 'void');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('queued', 'running', 'succeeded', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."job_type" AS ENUM('noop', 'provision', 'suspend', 'resume', 'terminate', 'backup_now', 'restore');--> statement-breakpoint
CREATE TYPE "public"."mailbox_status" AS ENUM('active', 'suspended', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."payment_method" AS ENUM('manual_transfer');--> statement-breakpoint
CREATE TYPE "public"."subscription_status" AS ENUM('pending', 'active', 'grace', 'suspended', 'terminated');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('superadmin', 'ops', 'client_admin', 'client_user');--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_user_id" uuid,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" text,
	"client_id" uuid,
	"result" text DEFAULT 'success' NOT NULL,
	"ip" "inet",
	"request_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"contact_email" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"terminated_at" timestamp with time zone,
	CONSTRAINT "clients_slug_format" CHECK ("clients"."slug" ~ '^[a-z0-9-]{3,30}$')
);
--> statement-breakpoint
CREATE TABLE "domains" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"environment_id" uuid,
	"fqdn" text NOT NULL,
	"status" "domain_status" DEFAULT 'pending_dns' NOT NULL,
	"verification_token" text NOT NULL,
	"verified_at" timestamp with time zone,
	"last_checked_at" timestamp with time zone,
	"last_error" text,
	"certificate_status" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "domains_fqdn_lower" CHECK ("domains"."fqdn" = lower("domains"."fqdn") AND length("domains"."fqdn") <= 253)
);
--> statement-breakpoint
CREATE TABLE "environments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"kind" "environment_kind" NOT NULL,
	"odoo_instance" text NOT NULL,
	"db_name" text NOT NULL,
	"url" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "environments_db_name_format" CHECK ("environments"."db_name" ~ '^[a-z0-9_]{1,63}$'),
	CONSTRAINT "environments_odoo_instance_format" CHECK ("environments"."odoo_instance" ~ '^[a-z0-9-]{3,40}$')
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" text NOT NULL,
	"client_id" uuid NOT NULL,
	"subscription_id" uuid,
	"amount" numeric(14, 2) NOT NULL,
	"currency" char(3) DEFAULT 'IDR' NOT NULL,
	"status" "invoice_status" DEFAULT 'unpaid' NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"payment_method" "payment_method" DEFAULT 'manual_transfer' NOT NULL,
	"payment_provider" text,
	"payment_reference" text,
	"proof_file" text,
	"proof_uploaded_at" timestamp with time zone,
	"confirmed_by" uuid,
	"confirmed_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"void_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoices_amount_nonneg" CHECK ("invoices"."amount" >= 0),
	CONSTRAINT "invoices_paid_confirmed" CHECK ("invoices"."status" <> 'paid' OR ("invoices"."confirmed_at" IS NOT NULL AND "invoices"."paid_at" IS NOT NULL)),
	CONSTRAINT "invoices_proof_file_format" CHECK ("invoices"."proof_file" IS NULL OR "invoices"."proof_file" ~ '^[A-Za-z0-9_-]{16,128}(\.(png|jpg|pdf))?$')
);
--> statement-breakpoint
CREATE TABLE "mail_domains" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"domain_id" uuid,
	"fqdn" text NOT NULL,
	"status" "domain_status" DEFAULT 'pending_dns' NOT NULL,
	"dkim_selector" text,
	"dns_checks" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mailboxes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mail_domain_id" uuid NOT NULL,
	"local_part" text NOT NULL,
	"quota_mb" integer DEFAULT 2048 NOT NULL,
	"status" "mailbox_status" DEFAULT 'active' NOT NULL,
	"rate_limit_per_hour" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mailboxes_local_part_format" CHECK ("mailboxes"."local_part" ~ '^[a-z0-9._-]{1,64}$'),
	CONSTRAINT "mailboxes_quota_pos" CHECK ("mailboxes"."quota_mb" > 0)
);
--> statement-breakpoint
CREATE TABLE "plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"price_amount" numeric(14, 2) NOT NULL,
	"currency" char(3) DEFAULT 'IDR' NOT NULL,
	"billing_period_months" integer DEFAULT 1 NOT NULL,
	"max_users" integer,
	"max_environments" integer,
	"max_mailboxes" integer,
	"features" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plans_price_nonneg" CHECK ("plans"."price_amount" >= 0),
	CONSTRAINT "plans_period_pos" CHECK ("plans"."billing_period_months" > 0)
);
--> statement-breakpoint
CREATE TABLE "provision_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" "job_type" NOT NULL,
	"status" "job_status" DEFAULT 'queued' NOT NULL,
	"client_id" uuid,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"log" text DEFAULT '' NOT NULL,
	"actor_user_id" uuid,
	"actor" text NOT NULL,
	"boss_job_id" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"status" "subscription_status" DEFAULT 'pending' NOT NULL,
	"current_period_start" timestamp with time zone,
	"current_period_end" timestamp with time zone,
	"grace_until" timestamp with time zone,
	"suspended_at" timestamp with time zone,
	"terminated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"keycloak_sub" text NOT NULL,
	"email" text,
	"display_name" text,
	"role" "user_role" DEFAULT 'client_user' NOT NULL,
	"client_id" uuid,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domains" ADD CONSTRAINT "domains_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domains" ADD CONSTRAINT "domains_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environments" ADD CONSTRAINT "environments_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_confirmed_by_users_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_domains" ADD CONSTRAINT "mail_domains_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_domains" ADD CONSTRAINT "mail_domains_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD CONSTRAINT "mailboxes_mail_domain_id_mail_domains_id_fk" FOREIGN KEY ("mail_domain_id") REFERENCES "public"."mail_domains"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provision_jobs" ADD CONSTRAINT "provision_jobs_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provision_jobs" ADD CONSTRAINT "provision_jobs_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_logs_occurred_idx" ON "audit_logs" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "audit_logs_client_idx" ON "audit_logs" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "audit_logs_action_idx" ON "audit_logs" USING btree ("action");--> statement-breakpoint
CREATE UNIQUE INDEX "clients_slug_uq" ON "clients" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "domains_fqdn_uq" ON "domains" USING btree ("fqdn");--> statement-breakpoint
CREATE INDEX "domains_client_idx" ON "domains" USING btree ("client_id");--> statement-breakpoint
CREATE UNIQUE INDEX "environments_client_kind_uq" ON "environments" USING btree ("client_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "environments_db_name_uq" ON "environments" USING btree ("db_name");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_number_uq" ON "invoices" USING btree ("number");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_payment_ref_uq" ON "invoices" USING btree ("payment_provider","payment_reference");--> statement-breakpoint
CREATE INDEX "invoices_client_idx" ON "invoices" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "invoices_status_idx" ON "invoices" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "mail_domains_fqdn_uq" ON "mail_domains" USING btree ("fqdn");--> statement-breakpoint
CREATE INDEX "mail_domains_client_idx" ON "mail_domains" USING btree ("client_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mailboxes_address_uq" ON "mailboxes" USING btree ("mail_domain_id","local_part");--> statement-breakpoint
CREATE UNIQUE INDEX "plans_code_uq" ON "plans" USING btree ("code");--> statement-breakpoint
CREATE INDEX "provision_jobs_status_idx" ON "provision_jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "provision_jobs_client_idx" ON "provision_jobs" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "provision_jobs_created_idx" ON "provision_jobs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "subscriptions_client_idx" ON "subscriptions" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "subscriptions_status_idx" ON "subscriptions" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "users_keycloak_sub_uq" ON "users" USING btree ("keycloak_sub");--> statement-breakpoint
CREATE INDEX "users_client_idx" ON "users" USING btree ("client_id");