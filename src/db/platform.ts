import { eq } from "drizzle-orm";
import type { Db } from "./client";
import { clients } from "./schema";
import { PLATFORM_SLUG } from "../lib/job-contract";

/**
 * Tenant internal `platform` (ADR 0018 D2, kontrak Fase 1 §0.1): tepat satu baris `clients` slug `platform`,
 * `is_platform=true` — menampung user superadmin/ops. Idempoten; dipanggil setelah migrasi (db/migrate.ts).
 * Bila slug `platform` sudah ada TANPA is_platform (tidak mungkin lewat form — slug reserved) → lempar, tidak
 * menimpa baris tenant orang lain diam-diam.
 */
export async function ensurePlatformTenant(db: Db): Promise<{ id: string; created: boolean }> {
  const inserted = await db
    .insert(clients)
    .values({ slug: PLATFORM_SLUG, name: "Platform (internal)", isPlatform: true })
    .onConflictDoNothing()
    .returning({ id: clients.id });
  if (inserted[0]) return { id: inserted[0].id, created: true };
  const row = (await db.select({ id: clients.id, isPlatform: clients.isPlatform }).from(clients).where(eq(clients.slug, PLATFORM_SLUG)).limit(1))[0];
  if (!row) throw new Error("tenant platform: is_platform sudah dipakai client lain");
  if (!row.isPlatform) throw new Error("tenant platform: slug 'platform' sudah ada tanpa is_platform — periksa manual");
  return { id: row.id, created: false };
}
