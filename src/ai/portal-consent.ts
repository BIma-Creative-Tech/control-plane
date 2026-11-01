/**
 * Console tenant › Privasi (US-13): tenant-admin mengubah consent AI tenantnya sendiri. clientId HANYA dari cakupan sesi
 * (decidePortalScope) — tidak pernah dari form. Dicatat hash-chain + audit dalam satu transaksi.
 */
import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { auditLogs, clients, users } from "../db/schema";
import type { AiConsent } from "../lib/ai-gateway";
import type { Actor, RequestMeta } from "../jobs/service";
import { writeAiConsentTx } from "./consent";

export type PortalConsentOutcome = { ok: true; changed: boolean } | { ok: false; reason: "forbidden" | "not_found" };

export async function portalSetAiConsent(
  db: Db,
  p: { clientId: string; userId: string; actor: Actor; meta: RequestMeta; consent: AiConsent; now?: Date },
): Promise<PortalConsentOutcome> {
  return db.transaction(async (tx) => {
    // aktor harus client_admin aktif DARI tenant yang sama (pertahanan berlapis selain requirePortal)
    const u = (await tx.select({ clientId: users.clientId, role: users.role, status: users.status }).from(users).where(eq(users.id, p.userId)).limit(1))[0];
    if (!u || u.clientId !== p.clientId || u.role !== "client_admin" || u.status !== "active") return { ok: false, reason: "forbidden" } as const;
    const c = (await tx.select({ id: clients.id, cur: clients.aiConsent, status: clients.status }).from(clients).where(eq(clients.id, p.clientId)).for("update").limit(1))[0];
    if (!c || c.status === "terminated") return { ok: false, reason: "not_found" } as const;
    const actor = `user:${p.actor.sub}`;
    const hash = await writeAiConsentTx(tx, c.id, p.consent, actor, p.now ?? new Date());
    await tx.insert(auditLogs).values({
      actorUserId: p.actor.userId,
      actor,
      action: "ai.consent",
      targetType: "client",
      targetId: c.id,
      clientId: c.id,
      result: "success",
      ip: p.meta.ip,
      requestId: p.meta.requestId,
      metadata: { channel: "portal", consent: { from: c.cur, to: p.consent }, hash },
    });
    return { ok: true, changed: c.cur !== p.consent } as const;
  });
}
