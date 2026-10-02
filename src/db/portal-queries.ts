/**
 * Query portal tenant (W6). SETIAP fungsi menerima `clientId` hasil decidePortalScope (users.client_id sesi) dan
 * memfilter dengan itu — tidak ada parameter lain dari request yang menentukan tenant. `db` disuntik (uji integrasi).
 */
import { and, asc, desc, eq, inArray, ne } from "drizzle-orm";
import type { Db } from "./client";
import { clients, domains, environments, invoices, plans, subscriptions, tenantUserAccess, users } from "./schema";
import { timestampToDate } from "../lib/billing";
import type { PortalTenantRow, PortalUserRow } from "../lib/portal";

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

/** Invoice terbuka (unpaid/awaiting_confirmation) tenant — tanpa referensi pembayaran/bukti. */
export async function portalOpenInvoices(db: Db, clientId: string) {
  const rows = await db
    .select({ id: invoices.id, number: invoices.number, kind: invoices.kind, status: invoices.status, amount: invoices.amount, currency: invoices.currency, dueAt: invoices.dueAt })
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

export async function portalDomains(db: Db, clientId: string) {
  return db
    .select({
      id: domains.id,
      fqdn: domains.fqdn,
      purpose: domains.purpose,
      status: domains.status,
      dkimTxt: domains.dkimTxt,
      verifiedAt: domains.verifiedAt,
      envKind: environments.kind,
    })
    .from(domains)
    .leftJoin(environments, eq(environments.id, domains.environmentId))
    .where(eq(domains.clientId, clientId))
    .orderBy(asc(domains.fqdn));
}
