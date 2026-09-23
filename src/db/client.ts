import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

export type Db = NodePgDatabase<typeof schema>;

/**
 * Pool Postgres + Drizzle. Semua query lewat query builder Drizzle (parameterized);
 * `sql.raw` dengan input user dilarang (CLAUDE.md §3.6).
 * Role `control_plane` CONNECTION LIMIT 20 → web max 8 + worker max 4 + migrasi 1.
 */
export function createDb(connectionString: string, options: { max: number; applicationName: string }) {
  const pool = new Pool({
    connectionString,
    max: options.max,
    application_name: options.applicationName,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 15_000,
  });
  const db: Db = drizzle({ client: pool, schema });
  return { db, pool };
}
