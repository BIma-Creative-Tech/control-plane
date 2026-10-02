/**
 * Query halaman Tenant / Audit / Realm (W5) — terparametrisasi Drizzle, `db` disuntik (dipakai page lewat getDb()
 * dan test integrasi). Filter sudah lolos whitelist (uuid/slug/regex) sebelum sampai sini.
 */
import { and, asc, count, desc, eq, gte, inArray, isNotNull, isNull, lt, sql, type SQL } from "drizzle-orm";
import type { Db } from "./client";
import { auditLogs, clients, provisionJobs, users } from "./schema";
import { AUDIT_PAGE_SIZE, type AuditParams } from "../lib/audit-params";
import { orderChain, type ChainStepRow } from "../lib/user-admin";

export async function getTenantBySlug(db: Db, slug: string) {
  return (
    (
      await db
        .select({
          id: clients.id,
          slug: clients.slug,
          name: clients.name,
          brand: clients.brand,
          status: clients.status,
          isolation: clients.isolation,
          kcOrgId: clients.kcOrgId,
          isPlatform: clients.isPlatform,
          createdAt: clients.createdAt,
          terminatedAt: clients.terminatedAt,
        })
        .from(clients)
        .where(eq(clients.slug, slug))
        .limit(1)
    )[0] ?? null
  );
}

/** User tenant (tanpa kolom sensitif lain). Email ditampilkan di halaman tenant/users (bukan audit). */
export async function listUsersOfTenant(db: Db, clientId: string) {
  return db
    .select({ id: users.id, email: users.email, displayName: users.displayName, role: users.role, status: users.status, lastLoginAt: users.lastLoginAt })
    .from(users)
    .where(eq(users.clientId, clientId))
    .orderBy(asc(users.email))
    .limit(200);
}

/**
 * Status `tenant_check` per env = job `odoo_tenant_config` terakhir (tidak ada kolom di environments — migrasi bukan
 * cakupan W5): sukses → RESULT `mode` (fallback args), aktif → status job, gagal → `failed`.
 */
export async function tenantCheckByEnv(db: Db, clientId: string) {
  const rows = await db
    .select({ env: provisionJobs.env, status: provisionJobs.status, result: provisionJobs.result, payload: provisionJobs.payload, dryRun: provisionJobs.dryRun, id: provisionJobs.id })
    .from(provisionJobs)
    .where(and(eq(provisionJobs.clientId, clientId), eq(provisionJobs.type, "odoo_tenant_config"), eq(provisionJobs.dryRun, false)))
    .orderBy(desc(provisionJobs.createdAt))
    .limit(30);
  const out = new Map<string, { label: string; status: string; jobId: string }>();
  for (const r of rows) {
    if (!r.env || out.has(r.env)) continue;
    const want = ((r.payload as { args?: { tenant_check?: unknown } }).args?.tenant_check ?? "?") as string;
    const label = r.status === "succeeded" ? (r.result?.mode ?? want) : `${want} (${r.status})`;
    out.set(r.env, { label, status: r.status, jobId: r.id });
  }
  return out;
}

export type ChainView = { chainId: string; createdAt: Date; actor: string; origin: string | null; steps: (ChainStepRow & { dryRun: boolean; result: Record<string, string> | null })[] };

/** Rantai job terbaru satu client (SEMUA tipe: onboarding, user, suspend/resume, realm) — status per langkah. */
export async function listClientChains(db: Db, clientId: string, maxChains = 10, types?: readonly string[]): Promise<ChainView[]> {
  const conds: SQL[] = [isNotNull(provisionJobs.chainId), eq(provisionJobs.clientId, clientId)];
  if (types) conds.push(inArray(provisionJobs.type, types as never[]));
  // Rantai terbaru dulu (id rantai), lalu semua langkahnya.
  const heads = await db
    .select({ chainId: provisionJobs.chainId, at: sql<Date>`max(${provisionJobs.createdAt})`.as("at") })
    .from(provisionJobs)
    .where(and(...conds))
    .groupBy(provisionJobs.chainId)
    .orderBy(desc(sql`max(${provisionJobs.createdAt})`))
    .limit(maxChains);
  const ids = heads.map((h) => h.chainId).filter((x): x is string => typeof x === "string");
  if (ids.length === 0) return [];
  const rows = await db
    .select({
      id: provisionJobs.id,
      chainId: provisionJobs.chainId,
      type: provisionJobs.type,
      env: provisionJobs.env,
      status: provisionJobs.status,
      errorCode: provisionJobs.errorCode,
      afterJobId: provisionJobs.afterJobId,
      createdAt: provisionJobs.createdAt,
      payload: provisionJobs.payload,
      actor: provisionJobs.actor,
      dryRun: provisionJobs.dryRun,
      result: provisionJobs.result,
    })
    .from(provisionJobs)
    .where(inArray(provisionJobs.chainId, ids))
    .orderBy(asc(provisionJobs.createdAt))
    .limit(maxChains * 24);
  const slug = (await db.select({ slug: clients.slug }).from(clients).where(eq(clients.id, clientId)).limit(1))[0]?.slug ?? null;
  // Asal rantai = aksi audit sukses yang memuat metadata.chain_id (tenant.onboard, user.add, …).
  const origins = await db
    .select({ action: auditLogs.action, chainId: sql<string>`${auditLogs.metadata} ->> 'chain_id'` })
    .from(auditLogs)
    .where(and(eq(auditLogs.clientId, clientId), eq(auditLogs.result, "success"), sql`${auditLogs.metadata} ->> 'chain_id' IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`));
  const originOf = new Map(origins.map((o) => [o.chainId, o.action]));
  const chains = new Map<string, ChainView>();
  for (const r of rows) {
    const cid = r.chainId as string;
    const args = ((r.payload as { args?: Record<string, unknown> }).args ?? {}) as Record<string, unknown>;
    const step = {
      id: r.id,
      type: r.type,
      env: r.env,
      status: r.status,
      errorCode: r.errorCode,
      afterJobId: r.afterJobId,
      createdAt: r.createdAt,
      email: typeof args.email === "string" ? args.email : null,
      slug,
      dryRun: r.dryRun,
      result: r.result ?? null,
    };
    const c = chains.get(cid);
    if (c) c.steps.push(step);
    else chains.set(cid, { chainId: cid, createdAt: r.createdAt, actor: r.actor, origin: originOf.get(cid) ?? null, steps: [step] });
  }
  return ids
    .map((id) => chains.get(id))
    .filter((c): c is ChainView => c !== undefined)
    .map((c) => ({ ...c, steps: orderChain(c.steps) as ChainView["steps"] }));
}

/** Job kc_realm_sync terbaru (plan & apply) untuk tenant platform. */
export async function listRealmSyncJobs(db: Db, platformId: string, limit = 10) {
  return db
    .select({
      id: provisionJobs.id,
      env: provisionJobs.env,
      status: provisionJobs.status,
      dryRun: provisionJobs.dryRun,
      errorCode: provisionJobs.errorCode,
      result: provisionJobs.result,
      payload: provisionJobs.payload,
      actor: provisionJobs.actor,
      createdAt: provisionJobs.createdAt,
      finishedAt: provisionJobs.finishedAt,
    })
    .from(provisionJobs)
    .where(and(eq(provisionJobs.clientId, platformId), eq(provisionJobs.type, "kc_realm_sync")))
    .orderBy(desc(provisionJobs.createdAt))
    .limit(limit);
}

/** Baris users lama tanpa tenant (`client_id IS NULL`) — kandidat adopsi setelah sync realm pertama (ADR 0017 F1d). */
export async function listUnboundUsers(db: Db, limit = 100) {
  return db
    .select({ id: users.id, email: users.email, role: users.role, status: users.status, lastLoginAt: users.lastLoginAt })
    .from(users)
    .where(isNull(users.clientId))
    .orderBy(asc(users.role), asc(users.email))
    .limit(limit);
}

function auditWhere(p: AuditParams): SQL | undefined {
  const conds: SQL[] = [];
  if (p.actorPrefix) conds.push(sql`starts_with(${auditLogs.actor}, ${p.actorPrefix})`);
  if (p.actionPrefix) conds.push(sql`starts_with(${auditLogs.action}, ${p.actionPrefix})`);
  if (p.result) conds.push(eq(auditLogs.result, p.result));
  if (p.from) conds.push(gte(auditLogs.occurredAt, p.from));
  if (p.toExclusive) conds.push(lt(auditLogs.occurredAt, p.toExclusive));
  if (p.tenant) conds.push(eq(clients.slug, p.tenant));
  return conds.length ? and(...conds) : undefined;
}

/**
 * Audit dengan filter + paginasi. TIDAK join `users.email` — aktor ditampilkan sebagai `user:<sub>`; metadata
 * disamarkan di tampilan (redactAuditMetadata).
 */
export async function queryAudit(db: Db, p: AuditParams) {
  const where = auditWhere(p);
  const [rows, totals] = await Promise.all([
    db
      .select({
        id: auditLogs.id,
        occurredAt: auditLogs.occurredAt,
        actor: auditLogs.actor,
        action: auditLogs.action,
        targetType: auditLogs.targetType,
        targetId: auditLogs.targetId,
        result: auditLogs.result,
        ip: auditLogs.ip,
        requestId: auditLogs.requestId,
        metadata: auditLogs.metadata,
        tenant: clients.slug,
      })
      .from(auditLogs)
      .leftJoin(clients, eq(clients.id, auditLogs.clientId))
      .where(where)
      .orderBy(desc(auditLogs.occurredAt), desc(auditLogs.id))
      .limit(AUDIT_PAGE_SIZE)
      .offset((p.page - 1) * AUDIT_PAGE_SIZE),
    db.select({ total: count() }).from(auditLogs).leftJoin(clients, eq(clients.id, auditLogs.clientId)).where(where),
  ]);
  return { rows, total: totals[0]?.total ?? 0 };
}
