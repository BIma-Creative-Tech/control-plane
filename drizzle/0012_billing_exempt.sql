ALTER TABLE "bctone_registrations" ADD COLUMN "billing_exempt" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "billing_exempt" boolean DEFAULT false NOT NULL;