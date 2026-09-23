import "server-only";
import { getWebEnv } from "@/env";
import { createDb, type Db } from "./client";

// Singleton per proses (disimpan di globalThis agar HMR dev tidak membuka pool baru).
const globalForDb = globalThis as unknown as { __cpDb?: Db };

export function getDb(): Db {
  globalForDb.__cpDb ??= createDb(getWebEnv().DATABASE_URL, { max: 8, applicationName: "control-plane-web" }).db;
  return globalForDb.__cpDb;
}
