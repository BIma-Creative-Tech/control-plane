import "server-only";
import { asc, count, ilike } from "drizzle-orm";
import { getDb } from "@/db";
import { clients } from "@/db/schema";
import type { ClientListParams } from "@/lib/client-list-params";

export const PAGE_SIZE = 50;

/** Query terparametrisasi Drizzle. `q` sudah lolos whitelist ^[a-z0-9-]{1,30}$ (tanpa wildcard LIKE). */
export async function listClients(params: ClientListParams) {
  const db = getDb();
  const where = params.q ? ilike(clients.slug, `%${params.q}%`) : undefined;
  const [rows, totals] = await Promise.all([
    db
      .select({ id: clients.id, slug: clients.slug, name: clients.name, createdAt: clients.createdAt })
      .from(clients)
      .where(where)
      .orderBy(asc(clients.slug))
      .limit(PAGE_SIZE)
      .offset((params.page - 1) * PAGE_SIZE),
    db.select({ total: count() }).from(clients).where(where),
  ]);
  return { rows, total: totals[0]?.total ?? 0 };
}
