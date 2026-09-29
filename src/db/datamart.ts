import "server-only";
import { Pool, type PoolClient } from "pg";
import { getWebEnv } from "@/env";

/**
 * Pool data mart (ADR 0016): role `datamart_reader` (NOBYPASSRLS, CONNECTION LIMIT 5 → max 3 di sini).
 * Setiap query dibungkus transaksi READ ONLY dengan `set_config(..., true)` = SET LOCAL (CLAUDE.md §3.3):
 * koneksi pool tidak pernah membawa konteks tenant/user dari request lain. Query hanya dengan parameter ($1..),
 * tanpa penggabungan string input user.
 */
const globalForDm = globalThis as unknown as { __cpDatamart?: Pool };

export function datamartEnabled(): boolean {
  const env = getWebEnv();
  return env.DATAMART_URL !== undefined && env.DATAMART_ENV !== undefined;
}

function pool(): Pool {
  const env = getWebEnv();
  if (!env.DATAMART_URL) throw new Error("DATAMART_URL tidak dikonfigurasi");
  globalForDm.__cpDatamart ??= new Pool({
    connectionString: env.DATAMART_URL,
    max: 3,
    application_name: "control-plane-dashboard",
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 10_000,
  });
  return globalForDm.__cpDatamart;
}

export type MartScope = { sub: string; client?: string };

/** Jalankan `fn` dalam transaksi read-only dengan app.sub (dan app.client bila ada) sebagai SET LOCAL. */
export async function withMart<T>(scope: MartScope, fn: (c: PoolClient, env: string) => Promise<T>): Promise<T> {
  const env = getWebEnv().DATAMART_ENV;
  if (!env) throw new Error("DATAMART_ENV tidak dikonfigurasi");
  const client = await pool().connect();
  try {
    await client.query("BEGIN READ ONLY");
    await client.query("SELECT set_config('app.sub', $1, true), set_config('app.client', $2, true)", [
      scope.sub,
      scope.client ?? "",
    ]);
    const result = await fn(client, env);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
