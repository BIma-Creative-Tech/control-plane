CREATE TYPE "public"."invoice_tax_scheme" AS ENUM('none', 'ppn_dpp_nilai_lain');--> statement-breakpoint
CREATE TYPE "public"."quota_metric" AS ENUM('users', 'devices', 'outlets', 'trx_per_month', 'omzet_per_month', 'ai_prompts_per_day');--> statement-breakpoint
CREATE TABLE "plan_quotas" (
	"plan_id" uuid NOT NULL,
	"metric" "quota_metric" NOT NULL,
	"limit_value" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plan_quotas_limit_nonneg" CHECK ("plan_quotas"."limit_value" >= 0)
);
--> statement-breakpoint
CREATE TABLE "tenant_usage_daily" (
	"client_id" uuid NOT NULL,
	"usage_date" date NOT NULL,
	"seq" integer DEFAULT 0 NOT NULL,
	"users" integer DEFAULT 0 NOT NULL,
	"devices" integer DEFAULT 0 NOT NULL,
	"outlets" integer DEFAULT 0 NOT NULL,
	"trx_month_gross" integer DEFAULT 0 NOT NULL,
	"omzet_month_net" numeric(16, 2) DEFAULT '0' NOT NULL,
	"ai_prompts" integer DEFAULT 0 NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_usage_daily_nonneg" CHECK ("tenant_usage_daily"."users" >= 0 AND "tenant_usage_daily"."devices" >= 0 AND "tenant_usage_daily"."outlets" >= 0 AND "tenant_usage_daily"."trx_month_gross" >= 0 AND "tenant_usage_daily"."omzet_month_net" >= 0 AND "tenant_usage_daily"."ai_prompts" >= 0 AND "tenant_usage_daily"."seq" >= 0)
);
--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "withholds_pph23" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "tax_scheme" "invoice_tax_scheme" DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "ppn_amount" numeric(14, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "pph23_amount" numeric(14, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "total_amount" numeric(14, 2);--> statement-breakpoint
ALTER TABLE "plan_quotas" ADD CONSTRAINT "plan_quotas_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_usage_daily" ADD CONSTRAINT "tenant_usage_daily_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "plan_quotas_plan_metric_uq" ON "plan_quotas" USING btree ("plan_id","metric");--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_usage_daily_uq" ON "tenant_usage_daily" USING btree ("client_id","usage_date");--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_tax_consistent" CHECK ("invoices"."tax_scheme" = 'none' OR ("invoices"."total_amount" = "invoices"."amount" + "invoices"."ppn_amount" AND "invoices"."pph23_amount" <= "invoices"."amount"));