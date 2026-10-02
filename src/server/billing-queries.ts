import "server-only";
import { and, asc, desc, eq, inArray, type SQL } from "drizzle-orm";
import { getDb } from "@/db";
import { clients, invoices, plans, subscriptions } from "@/db/schema";
import { timestampToDate } from "@/lib/billing";

/**
 * Query Subscriptions & Invoices (ADR 0018, W5) — terparametrisasi Drizzle; filter sudah lolos whitelist (uuid/slug/enum)
 * sebelum sampai sini. Pemanggil WAJIB sudah memeriksa izin `billing:view` (halaman/komponen tidak memeriksa ulang data).
 * Dapat dipakai halaman tenant (detail) — lihat app/billing/tenant-billing.tsx.
 */

export async function listBillingTenants() {
  return getDb()
    .select({ id: clients.id, slug: clients.slug, name: clients.name, status: clients.status, terminatedAt: clients.terminatedAt })
    .from(clients)
    .where(eq(clients.isPlatform, false))
    .orderBy(asc(clients.slug));
}

export async function listPlans() {
  return getDb()
    .select({
      id: plans.id,
      code: plans.code,
      name: plans.name,
      service: plans.service,
      priceAmount: plans.priceAmount,
      currency: plans.currency,
      billingPeriodMonths: plans.billingPeriodMonths,
      isActive: plans.isActive,
    })
    .from(plans)
    .orderBy(asc(plans.service), asc(plans.code));
}

export async function listSubscriptions(clientId: string | null) {
  const rows = await getDb()
    .select({
      id: subscriptions.id,
      clientId: subscriptions.clientId,
      slug: clients.slug,
      tenantName: clients.name,
      status: subscriptions.status,
      planCode: plans.code,
      planName: plans.name,
      service: plans.service,
      priceAmount: plans.priceAmount,
      currency: plans.currency,
      subPriceAmount: subscriptions.priceAmount,
      subPriceCurrency: subscriptions.priceCurrency,
      goLiveAt: subscriptions.goLiveAt,
      warrantyUntil: subscriptions.warrantyUntil,
      startsAt: subscriptions.currentPeriodStart,
      endsAt: subscriptions.currentPeriodEnd,
      graceUntil: subscriptions.graceUntil,
      notes: subscriptions.notes,
      createdAt: subscriptions.createdAt,
    })
    .from(subscriptions)
    .innerJoin(plans, eq(plans.id, subscriptions.planId))
    .innerJoin(clients, eq(clients.id, subscriptions.clientId))
    .where(clientId ? eq(subscriptions.clientId, clientId) : undefined)
    .orderBy(asc(clients.slug), desc(subscriptions.createdAt))
    .limit(500);
  return rows.map((r) => ({
    ...r,
    startsAt: timestampToDate(r.startsAt),
    endsAt: timestampToDate(r.endsAt),
    graceUntil: timestampToDate(r.graceUntil),
  }));
}

export const INVOICE_STATUS_FILTER = ["unpaid", "awaiting_confirmation", "paid", "void"] as const;
export type InvoiceStatusFilter = (typeof INVOICE_STATUS_FILTER)[number];

export async function listInvoices(filter: { clientId: string | null; status: InvoiceStatusFilter | null; openOnly?: boolean }) {
  const conds: SQL[] = [];
  if (filter.clientId) conds.push(eq(invoices.clientId, filter.clientId));
  if (filter.status) conds.push(eq(invoices.status, filter.status));
  if (filter.openOnly) conds.push(inArray(invoices.status, ["unpaid", "awaiting_confirmation"]));
  const rows = await getDb()
    .select({
      id: invoices.id,
      number: invoices.number,
      clientId: invoices.clientId,
      slug: clients.slug,
      kind: invoices.kind,
      status: invoices.status,
      amount: invoices.amount,
      currency: invoices.currency,
      issuedAt: invoices.issuedAt,
      dueAt: invoices.dueAt,
      paidAt: invoices.paidAt,
      periodStart: invoices.periodStart,
      periodEnd: invoices.periodEnd,
      subscriptionId: invoices.subscriptionId,
      paymentReference: invoices.paymentReference,
      proofReference: invoices.proofReference,
      voidReason: invoices.voidReason,
    })
    .from(invoices)
    .innerJoin(clients, eq(clients.id, invoices.clientId))
    .where(conds.length > 0 ? and(...conds) : undefined)
    .orderBy(desc(invoices.issuedAt))
    .limit(500);
  return rows.map((r) => ({
    ...r,
    issuedAt: timestampToDate(r.issuedAt),
    dueAt: timestampToDate(r.dueAt),
    paidAt: timestampToDate(r.paidAt),
  }));
}

/** Ringkasan untuk disematkan di halaman tenant: langganan non-terminated + invoice terbuka. */
export async function getTenantBillingSummary(clientId: string) {
  const [subs, open] = await Promise.all([
    listSubscriptions(clientId).then((rows) => rows.filter((r) => r.status !== "terminated")),
    listInvoices({ clientId, status: null, openOnly: true }),
  ]);
  return { subscriptions: subs, openInvoices: open };
}

