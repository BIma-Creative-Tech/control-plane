/**
 * Query portal tenant (W6). SETIAP fungsi menerima `clientId` hasil decidePortalScope (users.client_id sesi) dan
 * memfilter dengan itu — tidak ada parameter lain dari request yang menentukan tenant. `db` disuntik (uji integrasi).
 */
import { and, asc, desc, eq, inArray, ne } from "drizzle-orm";
import type { Db } from "./client";
import { aiConsentLog, clients, environments, invoices, planQuotas, plans, subscriptions, tenantAiDaily, tenantUsageDaily, tenantUserAccess, users } from "./schema";
import { listTenantDomains } from "./tenant-queries";
import { timestampToDate } from "../lib/billing";
import type { PortalTenantRow, PortalUserRow } from "../lib/portal";
import type { QuotaMetric } from "../lib/bctone-quota";

/** Baris users sesi (by sub Keycloak) + tenant-nya — bahan decidePortalScope. Read-only (tidak membuat baris). */
export async function loadPortalIdentity(db: Db, sub: string): Promise<{ user: PortalUserRow | null; tenant: PortalTenantRow | null }> {
  const user = (
    await db.select({ id: users.id, clientId: users.clientId, status: users.status, role: users.role }).from(users).where(eq(users.keycloakSub, sub)).limit(1)
  )[0];
  if (!user) return { user: null, tenant: null };
  const tenant = user.clientId
    ? ((
        await db
          .select({ id: clients.id, slug: clients.slug, name: clients.name, status: clients.status, isPlatform: clients.isPlatform, terminatedAt: clients.terminatedAt })
          .from(clients)
          .where(eq(clients.id, user.clientId))
          .limit(1)
      )[0] ?? null)
    : null;
  return { user, tenant };
}

export async function portalEnvironments(db: Db, clientId: string) {
  return db
    .select({
      id: environments.id,
      kind: environments.kind,
      host: environments.host,
      dbStatus: environments.dbStatus,
      routeStatus: environments.routeStatus,
      ssoStatus: environments.ssoStatus,
    })
    .from(environments)
    .where(eq(environments.clientId, clientId))
    .orderBy(asc(environments.kind));
}

/** Langganan non-terminated tenant (status siklus ADR 0018 D4). */
export async function portalSubscriptions(db: Db, clientId: string) {
  const rows = await db
    .select({
      id: subscriptions.id,
      status: subscriptions.status,
      planName: plans.name,
      service: plans.service,
      maxUsers: plans.maxUsers,
      goLiveAt: subscriptions.goLiveAt,
      warrantyUntil: subscriptions.warrantyUntil,
      endsAt: subscriptions.currentPeriodEnd,
      graceUntil: subscriptions.graceUntil,
    })
    .from(subscriptions)
    .innerJoin(plans, eq(plans.id, subscriptions.planId))
    .where(and(eq(subscriptions.clientId, clientId), ne(subscriptions.status, "terminated")))
    .orderBy(asc(plans.service), desc(subscriptions.createdAt));
  return rows.map((r) => ({ ...r, endsAt: timestampToDate(r.endsAt), graceUntil: timestampToDate(r.graceUntil) }));
}

/**
 * BCTOne Console — paket self-serve aktif + batas kuota + pemakaian terakhir (laporan agen) + prompt AI hari ini (WIB) +
 * consent AI berlaku. null = tenant tanpa langganan BCTOne (halaman menampilkan info saja).
 */
export async function portalBctone(db: Db, clientId: string, today: string) {
  const sub = (
    await db
      .select({ planId: plans.id, code: plans.code, name: plans.name, status: subscriptions.status, endsAt: subscriptions.currentPeriodEnd })
      .from(subscriptions)
      .innerJoin(plans, eq(plans.id, subscriptions.planId))
      .where(and(eq(subscriptions.clientId, clientId), eq(subscriptions.lifecycle, "self_serve"), ne(subscriptions.status, "terminated")))
      .orderBy(desc(subscriptions.createdAt))
      .limit(1)
  )[0];
  if (!sub) return null;
  const [quotas, usage, ai, client, history] = await Promise.all([
    db.select({ metric: planQuotas.metric, limit: planQuotas.limitValue }).from(planQuotas).where(eq(planQuotas.planId, sub.planId)),
    db.select().from(tenantUsageDaily).where(eq(tenantUsageDaily.clientId, clientId)).orderBy(desc(tenantUsageDaily.usageDate)).limit(1),
    db
      .select({ prompts: tenantAiDaily.prompts })
      .from(tenantAiDaily)
      .where(and(eq(tenantAiDaily.clientId, clientId), eq(tenantAiDaily.usageDate, today)))
      .limit(1),
    db.select({ consent: clients.aiConsent }).from(clients).where(eq(clients.id, clientId)).limit(1),
    db
      .select({ consent: aiConsentLog.consent, createdAt: aiConsentLog.createdAt, hash: aiConsentLog.hash })
      .from(aiConsentLog)
      .where(eq(aiConsentLog.clientId, clientId))
      .orderBy(desc(aiConsentLog.id))
      .limit(5),
  ]);
  return {
    plan: { code: sub.code, name: sub.name, status: sub.status, endsAt: timestampToDate(sub.endsAt) },
    limits: Object.fromEntries(quotas.map((q) => [q.metric, q.limit])) as Partial<Record<QuotaMetric, number>>,
    usage: usage[0] ?? null,
    aiToday: ai[0]?.prompts ?? 0,
    consent: client[0]?.consent ?? null,
    history,
  };
}

/** Invoice terbuka (unpaid/awaiting_confirmation) tenant — tanpa referensi pembayaran/bukti. */
export async function portalOpenInvoices(db: Db, clientId: string) {
  const rows = await db
    .select({ id: invoices.id, number: invoices.number, kind: invoices.kind, status: invoices.status, amount: invoices.amount, currency: invoices.currency, dueAt: invoices.dueAt, taxScheme: invoices.taxScheme, ppnAmount: invoices.ppnAmount, pph23Amount: invoices.pph23Amount, totalAmount: invoices.totalAmount })
    .from(invoices)
    .where(and(eq(invoices.clientId, clientId), inArray(invoices.status, ["unpaid", "awaiting_confirmation"])))
    .orderBy(asc(invoices.dueAt));
  return rows.map((r) => ({ ...r, dueAt: timestampToDate(r.dueAt) }));
}

export async function portalUsers(db: Db, clientId: string) {
  return db
    .select({ id: users.id, email: users.email, displayName: users.displayName, role: users.role, status: users.status, lastLoginAt: users.lastLoginAt })
    .from(users)
    .where(eq(users.clientId, clientId))
    .orderBy(asc(users.email))
    .limit(500);
}

/** Akses Odoo per environment tenant (tenant_user_access) — hanya environment milik tenant ini. */
export async function portalAccess(db: Db, clientId: string) {
  return db
    .select({ environmentId: tenantUserAccess.environmentId, email: tenantUserAccess.email, status: tenantUserAccess.status, isAdmin: tenantUserAccess.isTenantAdmin })
    .from(tenantUserAccess)
    .innerJoin(environments, eq(environments.id, tenantUserAccess.environmentId))
    .where(eq(environments.clientId, clientId));
}

/** Domain tenant + checklist bahan (sama dengan halaman tenant platform, db/tenant-queries.ts). */
export async function portalDomains(db: Db, clientId: string) {
  return listTenantDomains(db, clientId);
}
