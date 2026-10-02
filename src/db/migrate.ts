/**
 * Terapkan migrasi Drizzle (./drizzle) ke DATABASE_URL. Dibundel ke dist/db/migrate.mjs.
 * Pemakaian di container: `node dist/db/migrate.mjs` (lihat README §Migrasi). Setelah migrasi: pastikan tenant
 * internal `platform` ada dan 7 plan awal ADR 0018 D7 (idempoten).
 * API: node_modules/drizzle-orm/node-postgres/migrator.d.ts → migrate(db, { migrationsFolder }).
 */
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { getWorkerEnv } from "../env";
import { logger } from "../lib/logger";
import { createDb } from "./client";
import { ensureInitialPlans } from "./plans";
import { ensurePlatformTenant } from "./platform";

async function main(): Promise<void> {
  const env = getWorkerEnv();
  const migrationsFolder = process.env.MIGRATIONS_DIR ?? "./drizzle";
  const { db, pool } = createDb(env.DATABASE_URL, { max: 1, applicationName: "control-plane-migrate" });
  try {
    await migrate(db, { migrationsFolder });
    logger.info({ migrationsFolder }, "migrasi selesai");
    // Langkah boot idempoten (kontrak Fase 1 §0.1): tenant internal `platform`.
    const p = await ensurePlatformTenant(db);
    logger.info({ created: p.created }, "tenant platform siap");
    // ADR 0018 D7: 7 plan awal (harga NULL), idempoten — plan yang sudah ada tidak diubah.
    const pl = await ensureInitialPlans(db);
    logger.info(pl, "plan awal siap");
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  logger.error({ err: err instanceof Error ? err.message : String(err) }, "migrasi gagal");
  process.exit(1);
});
