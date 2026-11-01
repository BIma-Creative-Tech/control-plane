import "server-only";
import { eq, lt, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { auditLogs, clients, tenantUsageDaily } from "@/db/schema";
import type { UsagePayload } from "@/lib/usage-ingest";

/**
 * Simpan pemakaian harian (upsert per (client, tanggal), hanya bila `seq` lebih besar). Tenant terminated ditolak.
 * Return `stale` = seq tidak lebih baru (replay/duplikat) — bukan error.
 */
export async function upsertTenantUsage(db: Db, slug: string, p: UsagePayload): Promise<"stored" | "stale" | "unknown_tenant"> {
  const client = (await db.select({ id: clients.id, status: clients.status }).from(clients).where(eq(clients.slug, slug)).limit(1))[0];
  if (!client || client.status === "terminated") return "unknown_tenant";
  const values = {
    clientId: client.id,
    usageDate: p.date,
    seq: p.seq,
    users: p.users,
    devices: p.devices,
    outlets: p.outlets,
    trxMonthGross: p.trx_month_gross,
    omzetMonthNet: p.omzet_month_net,
    aiPrompts: p.ai_prompts,
  };
  const r = await db
    .insert(tenantUsageDaily)
    .values(values)
    .onConflictDoUpdate({
      target: [tenantUsageDaily.clientId, tenantUsageDaily.usageDate],
      set: { ...values, receivedAt: sql`now()` },
      setWhere: lt(tenantUsageDaily.seq, p.seq),
    })
    .returning({ seq: tenantUsageDaily.seq });
  if (r.length === 0) return "stale";
  await db.insert(auditLogs).values({
    actor: `tenant-agent:${slug}`,
    action: "usage.ingest",
    targetType: "client",
    targetId: client.id,
    clientId: client.id,
    result: "success",
    metadata: { date: p.date, seq: p.seq },
  });
  return "stored";
}
