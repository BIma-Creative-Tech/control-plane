CREATE TYPE "public"."ai_consent" AS ENUM('allow', 'deny');--> statement-breakpoint
CREATE TABLE "ai_consent_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"client_id" uuid NOT NULL,
	"consent" "ai_consent" NOT NULL,
	"actor" text NOT NULL,
	"created_at" timestamp (3) with time zone NOT NULL,
	"prev_hash" text,
	"hash" text NOT NULL,
	CONSTRAINT "ai_consent_log_hash_fmt" CHECK ("ai_consent_log"."hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "tenant_ai_daily" (
	"client_id" uuid NOT NULL,
	"usage_date" date NOT NULL,
	"prompts" integer DEFAULT 0 NOT NULL,
	"denied" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "tenant_ai_daily_nonneg" CHECK ("tenant_ai_daily"."prompts" >= 0 AND "tenant_ai_daily"."denied" >= 0)
);
--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "ai_consent" "ai_consent";--> statement-breakpoint
ALTER TABLE "ai_consent_log" ADD CONSTRAINT "ai_consent_log_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_ai_daily" ADD CONSTRAINT "tenant_ai_daily_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_consent_log_hash_uq" ON "ai_consent_log" USING btree ("hash");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_consent_log_prev_uq" ON "ai_consent_log" USING btree ("prev_hash");--> statement-breakpoint
CREATE INDEX "ai_consent_log_client_idx" ON "ai_consent_log" USING btree ("client_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_ai_daily_uq" ON "tenant_ai_daily" USING btree ("client_id","usage_date");--> statement-breakpoint
-- BR-07: rantai tunggal (satu genesis) + append-only (UPDATE/DELETE/TRUNCATE ditolak). Ditulis tangan.
CREATE UNIQUE INDEX "ai_consent_log_genesis_uq" ON "ai_consent_log" ((true)) WHERE "prev_hash" IS NULL;--> statement-breakpoint
CREATE FUNCTION "ai_consent_log_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ai_consent_log append-only (BR-07)' USING ERRCODE = 'insufficient_privilege';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "ai_consent_log_no_update_delete" BEFORE UPDATE OR DELETE ON "ai_consent_log" FOR EACH ROW EXECUTE FUNCTION "ai_consent_log_append_only"();--> statement-breakpoint
CREATE TRIGGER "ai_consent_log_no_truncate" BEFORE TRUNCATE ON "ai_consent_log" FOR EACH STATEMENT EXECUTE FUNCTION "ai_consent_log_append_only"();
