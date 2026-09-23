/**
 * Terapkan migrasi Drizzle (./drizzle) ke DATABASE_URL. Dibundel ke dist/db/migrate.mjs.
 * Pemakaian di container: `node dist/db/migrate.mjs` (lihat README §Migrasi).
 * API: node_modules/drizzle-orm/node-postgres/migrator.d.ts → migrate(db, { migrationsFolder }).
 */
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { getWorkerEnv } from "../env";
import { logger } from "../lib/logger";
import { createDb } from "./client";

async function main(): Promise<void> {
  const env = getWorkerEnv();
  const migrationsFolder = process.env.MIGRATIONS_DIR ?? "./drizzle";
  const { db, pool } = createDb(env.DATABASE_URL, { max: 1, applicationName: "control-plane-migrate" });
  try {
    await migrate(db, { migrationsFolder });
    logger.info({ migrationsFolder }, "migrasi selesai");
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  logger.error({ err: err instanceof Error ? err.message : String(err) }, "migrasi gagal");
  process.exit(1);
});
