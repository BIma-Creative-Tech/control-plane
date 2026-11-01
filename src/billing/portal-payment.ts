/**
 * Console tenant › Tagihan: tenant-admin melaporkan pembayaran manual (transfer) untuk invoice terbuka miliknya →
 * `awaiting_confirmation` (BR-18: tidak memicu suspend; staf mengonfirmasi lewat markInvoicePaid). Klien pemotong PPh 23
 * wajib mengisi nomor bukti potong. clientId HANYA dari cakupan sesi. Tanpa upload file (Fase 1: referensi teks).
 */
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client";
import { auditLogs, clients, invoices, users } from "../db/schema";
import { isAfter, isIsoDate, jakartaDate } from "../lib/billing";
import type { Actor, RequestMeta } from "../jobs/service";

const text = (min: number, max: number) =>
  z
    .string()
    .transform((v) => v.replace(/\s+/g, " ").trim())
    .pipe(z.string().min(min).max(max).regex(/^[\p{L}\p{N} .,:;/#()_+-]+$/u, "karakter"));

export const reportPaymentSchema = z
  .object({
    invoiceId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
    paid_on: z.string().trim().refine(isIsoDate, "tanggal"),
    bank_reference: text(3, 120),
    pph23_reference: z.union([z.literal(""), text(3, 120)]).optional(),
  })
  .strict();
export type ReportPaymentInput = z.infer<typeof reportPaymentSchema>;

export type ReportPaymentOutcome = { ok: true } | { ok: false; reason: "forbidden" | "not_found" | "invoice_state" | "future_date" | "pph23_required" };

export async function portalReportPayment(
  db: Db,
  p: { clientId: string; userId: string; actor: Actor; meta: RequestMeta; form: ReportPaymentInput; now?: Date },
): Promise<ReportPaymentOutcome> {
  const now = p.now ?? new Date();
  return db.transaction(async (tx) => {
    const u = (await tx.select({ clientId: users.clientId, role: users.role, status: users.status }).from(users).where(eq(users.id, p.userId)).limit(1))[0];
    if (!u || u.clientId !== p.clientId || u.role !== "client_admin" || u.status !== "active") return { ok: false, reason: "forbidden" } as const;
    // invoice tenant lain = not_found (tanpa oracle keberadaan)
    const inv = (
      await tx
        .select({ id: invoices.id, number: invoices.number, status: invoices.status, pph23: invoices.pph23Amount })
        .from(invoices)
        .where(and(eq(invoices.id, p.form.invoiceId), eq(invoices.clientId, p.clientId)))
        .for("update")
        .limit(1)
    )[0];
    if (!inv) return { ok: false, reason: "not_found" } as const;
    if (inv.status !== "unpaid") return { ok: false, reason: "invoice_state" } as const;
    if (isAfter(p.form.paid_on, jakartaDate(now))) return { ok: false, reason: "future_date" } as const;
    const c = (await tx.select({ w: clients.withholdsPph23 }).from(clients).where(eq(clients.id, p.clientId)).limit(1))[0];
    const pph = p.form.pph23_reference || null;
    if (c?.w && Number(inv.pph23) > 0 && !pph) return { ok: false, reason: "pph23_required" } as const;
    const proof = [`transfer ${p.form.paid_on}: ${p.form.bank_reference}`, pph ? `bukti potong PPh 23: ${pph}` : null].filter(Boolean).join(" | ");
    await tx
      .update(invoices)
      .set({ status: "awaiting_confirmation", proofReference: proof.slice(0, 200), proofUploadedAt: now, updatedAt: sql`now()` })
      .where(eq(invoices.id, inv.id));
    await tx.insert(auditLogs).values({
      actorUserId: p.actor.userId,
      actor: `user:${p.actor.sub}`,
      action: "invoice.payment_reported",
      targetType: "invoice",
      targetId: inv.id,
      clientId: p.clientId,
      result: "success",
      ip: p.meta.ip,
      requestId: p.meta.requestId,
      metadata: { channel: "portal", number: inv.number, paid_on: p.form.paid_on, has_pph23: pph !== null },
    });
    return { ok: true } as const;
  });
}
