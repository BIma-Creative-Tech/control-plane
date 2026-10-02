/**
 * Integrasi portal tenant W6 (Postgres nyata, TANPA dispatcher — job cukup ter-enqueue): kanal portal di atas layanan
 * Users. IDOR lintas tenant (userId/env tenant lain), eskalasi role, aturan F1 (email terikat, staf platform, diri
 * sendiri, adopt), batas user plan (termasuk job yang sedang berjalan + paralel), dan query portal hanya tenant sendiri.
 * Postgres SEKALI PAKAI (TEST_DATABASE_URL; skema di-DROP).
 */
import { and, eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSubscription } from "@/billing/service";
import { createDb, type Db } from "@/db/client";
import { ensureInitialPlans } from "@/db/plans";
import { ensurePlatformTenant } from "@/db/platform";
import {
  loadPortalIdentity,
  portalAccess,
  portalDomains,
  portalEnvironments,
  portalOpenInvoices,
  portalSubscriptions,
  portalUsers,
} from "@/db/portal-queries";
import { auditLogs, clients, domains, environments, invoices, plans, provisionJobs, tenantUserAccess, users } from "@/db/schema";
import { portalAddUser, portalChangeAccess, portalPasswordReset, portalSetUserEnabled } from "@/jobs/portal";
import type { Actor, SendFn } from "@/jobs/service";
import { addUser, adoptUser, changeUserAccess, countTenantSeats, setUserEnabled } from "@/jobs/users";
import { BRIDGE_JOB_TYPES } from "@/lib/job-contract";
import { decidePortalScope } from "@/lib/portal";

const URL_ = process.env.TEST_DATABASE_URL;
const META = { ip: "203.0.113.11", requestId: "req-portal" };

describe.skipIf(!URL_)("Portal tenant W6 ⇄ layanan Users (Postgres nyata)", () => {
  let db: Db;
  let pool: { end: () => Promise<void> };
  const send: SendFn = async () => null;
  const ALL = [...BRIDGE_JOB_TYPES];
  let acmeId: string;
  let betaId: string;
  let platformId: string;
  let envAcme: string;
  let envBeta: string;
  let ADMIN: Actor;
  let BUDI_ACTOR: Actor;
  let SUPER: Actor;
  let budiId: string;
  let betaUserId: string;
  let staffInAcmeId: string;
  let legacyId: string;
  let adminRowId: string;
  const base = (actor: Actor) => ({ instance: "prod" as const, allowedTypes: ALL, actor, meta: META });
  const jobs = async () => (await db.select().from(provisionJobs)).length;
  /** Rate limit aktor 10 rantai/menit: geser job yang ada 2 menit ke belakang. */
  const ageActorRate = () => db.execute(sql`UPDATE provision_jobs SET created_at = created_at - interval '2 minutes'`);
  const rejected = async (action: string) =>
    db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, action), eq(auditLogs.result, "rejected"), eq(auditLogs.actorUserId, ADMIN.userId!)));

  beforeAll(async () => {
    ({ db, pool } = createDb(URL_!, { max: 6, applicationName: "cp-int-portal" }));
    await db.execute(sql`DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA IF EXISTS pgboss CASCADE; CREATE SCHEMA public;`);
    await migrate(db, { migrationsFolder: "./drizzle" });
    platformId = (await ensurePlatformTenant(db)).id;
    await ensureInitialPlans(db);
    const [a] = await db.insert(clients).values({ slug: "acme-co", name: "Acme", kcOrgId: "0f0e0d0c-1111-4222-8333-444455556666" }).returning();
    const [b] = await db.insert(clients).values({ slug: "beta-co", name: "Beta", kcOrgId: "1f0e0d0c-1111-4222-8333-444455556666" }).returning();
    acmeId = a!.id;
    betaId = b!.id;
    const env = (clientId: string, slug: string) => ({
      clientId,
      kind: "prod" as const,
      odooInstance: "pool-a",
      dbName: `${slug.replace(/-/g, "_")}_prod`,
      url: `https://${slug}.erp.bimacreative.tech`,
      host: `${slug}.erp.bimacreative.tech`,
      dbStatus: "provisioned" as const,
      routeStatus: "active" as const,
      ssoStatus: "active" as const,
    });
    envAcme = (await db.insert(environments).values(env(acmeId, "acme-co")).returning())[0]!.id;
    envBeta = (await db.insert(environments).values(env(betaId, "beta-co")).returning())[0]!.id;
    const ins = async (v: typeof users.$inferInsert) => (await db.insert(users).values(v).returning())[0]!.id;
    const sa = await ins({ keycloakSub: "super-sub", role: "superadmin", clientId: platformId, email: "root@bimacreative.tech" });
    adminRowId = await ins({ keycloakSub: "acme-admin-sub", email: "admin@acme.co.id", role: "client_admin", status: "active", clientId: acmeId });
    budiId = await ins({ keycloakSub: "budi-sub", email: "budi@acme.co.id", role: "client_user", status: "active", clientId: acmeId });
    betaUserId = await ins({ keycloakSub: "beta-sub", email: "u@beta.co.id", role: "client_user", status: "active", clientId: betaId });
    // Drift: baris ber-role cache platform (ops) tercatat di tenant acme — portal tidak boleh menyentuhnya.
    staffInAcmeId = await ins({ keycloakSub: "staff-sub", email: "staff@bimacreative.tech", role: "ops", status: "active", clientId: acmeId });
    legacyId = await ins({ keycloakSub: "legacy-sub", email: "legacy@acme.co.id", role: "client_user", status: "active", clientId: null });
    await db.insert(tenantUserAccess).values({ environmentId: envAcme, email: "budi@acme.co.id", status: "active" });
    ADMIN = { sub: "acme-admin-sub", userId: adminRowId, roles: ["client_admin"] };
    BUDI_ACTOR = { sub: "budi-sub", userId: budiId, roles: ["client_user"] };
    SUPER = { sub: "super-sub", userId: sa, roles: ["superadmin"] };
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
  });

  it("tambah user dari portal: tenant = users.client_id aktor, role client_user, rantai + audit (tanpa langganan → tidak dicek, dicatat)", async () => {
    const r = await portalAddUser(db, send, { ...base(ADMIN), email: "Sari@Acme.co.id", name: "Sari", odoo: { [envAcme]: "user" } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const rows = await db.select().from(provisionJobs).where(eq(provisionJobs.chainId, r.chainId));
    expect(rows.every((j) => j.clientId === acmeId)).toBe(true);
    const roles = rows.find((j) => j.type === "kc_user_set_roles")!;
    expect((roles.payload as { args: Record<string, unknown> }).args).toEqual({ email: "sari@acme.co.id", cp_role: "client_user", odoo: "user" });
    expect(rows.map((j) => j.type).sort()).toEqual(["kc_user_ensure", "kc_user_set_roles", "odoo_user_ensure"]);
    const a = (await db.select().from(auditLogs).where(and(eq(auditLogs.action, "user.add"), eq(auditLogs.result, "success"))))[0]!;
    expect(a.metadata).toMatchObject({ scope: "own", channel: "portal", cp_role: "client_user", plan_limit: { kind: "no_subscription" } });
    expect(JSON.stringify(a.metadata)).not.toContain("sari@");
  });

  it("IDOR: userId / environment tenant lain → cross_tenant / env_unknown, tanpa job, diaudit", async () => {
    const j0 = await jobs();
    const X = { ok: false, reason: "authz", denial: "cross_tenant" };
    expect(await portalChangeAccess(db, send, { ...base(ADMIN), userId: betaUserId, odoo: {} })).toEqual(X);
    expect(await portalSetUserEnabled(db, send, { ...base(ADMIN), userId: betaUserId, enabled: false })).toEqual(X);
    expect(await portalPasswordReset(db, send, { ...base(ADMIN), userId: betaUserId })).toEqual(X);
    // env tenant lain di field odoo_<id>
    expect(await portalAddUser(db, send, { ...base(ADMIN), email: "x1@acme.co.id", name: null, odoo: { [envBeta]: "admin" } })).toEqual({
      ok: false,
      reason: "precondition",
      detail: "env_unknown",
    });
    expect(await portalChangeAccess(db, send, { ...base(ADMIN), userId: budiId, odoo: { [envBeta]: "admin" } })).toEqual({
      ok: false,
      reason: "precondition",
      detail: "env_unknown",
    });
    // Layanan dengan clientId tenant lain (form dimanipulasi — tidak mungkin lewat aksi portal, uji pertahanan berlapis).
    expect(await addUser(db, send, { ...base(ADMIN), channel: "portal", clientId: betaId, email: "x2@beta.co.id", name: null, cpRole: "client_user", odoo: {} })).toEqual(X);
    expect(await jobs()).toBe(j0);
    const rej = await rejected("user.change_access");
    expect(rej.some((x) => (x.metadata as { denial?: string }).denial === "cross_tenant" && x.clientId === betaId)).toBe(true);
  });

  it("eskalasi role: client_admin tidak bisa memberi client_admin/staf; client_user & superadmin tidak bisa memakai kanal portal; kanal platform tetap tertutup (F1.3)", async () => {
    const j0 = await jobs();
    const RNA = { ok: false, reason: "authz", denial: "role_not_allowed" };
    const F = { ok: false, reason: "authz", denial: "forbidden" };
    expect(await addUser(db, send, { ...base(ADMIN), channel: "portal", clientId: acmeId, email: "boss@acme.co.id", name: null, cpRole: "client_admin", odoo: {} })).toEqual(RNA);
    expect(await addUser(db, send, { ...base(ADMIN), channel: "portal", clientId: acmeId, email: "boss@acme.co.id", name: null, cpRole: "ops", odoo: {} })).toEqual(RNA);
    expect(await changeUserAccess(db, send, { ...base(ADMIN), channel: "portal", userId: budiId, cpRole: "client_admin", odoo: {} })).toEqual(RNA);
    // client_user (role sesi) → forbidden di layanan
    expect(await portalAddUser(db, send, { ...base(BUDI_ACTOR), email: "y@acme.co.id", name: null, odoo: {} })).toEqual(F);
    expect(await portalSetUserEnabled(db, send, { ...base(BUDI_ACTOR), userId: budiId, enabled: false })).toEqual(F);
    // superadmin lewat kanal portal → forbidden (staf memakai /users)
    expect(await addUser(db, send, { ...base(SUPER), channel: "portal", clientId: acmeId, email: "z@acme.co.id", name: null, cpRole: "client_user", odoo: {} })).toEqual(F);
    // client_admin lewat kanal platform (/users) → forbidden walau users:manage_own kini aktif
    expect(await addUser(db, send, { ...base(ADMIN), clientId: acmeId, email: "z@acme.co.id", name: null, cpRole: "client_user", odoo: {} })).toEqual(F);
    expect(await setUserEnabled(db, send, { ...base(ADMIN), userId: budiId, enabled: false })).toEqual(F);
    // adopt tidak pernah (kanal portal maupun platform)
    expect(await adoptUser(db, send, { ...base(ADMIN), channel: "portal", userId: legacyId, clientId: acmeId, cpRole: "client_user" })).toEqual(F);
    expect(await adoptUser(db, send, { ...base(ADMIN), userId: legacyId, clientId: acmeId, cpRole: "client_user" })).toEqual(F);
    expect(await jobs()).toBe(j0);
  });

  it("aturan F1 tetap: email tenant lain / user lama tanpa tenant / staf platform; diri sendiri; target staf platform", async () => {
    const j0 = await jobs();
    expect(await portalAddUser(db, send, { ...base(ADMIN), email: "u@beta.co.id", name: null, odoo: {} })).toEqual({ ok: false, reason: "precondition", detail: "email_other_tenant" });
    expect(await portalAddUser(db, send, { ...base(ADMIN), email: "legacy@acme.co.id", name: null, odoo: {} })).toEqual({ ok: false, reason: "precondition", detail: "email_unbound" });
    expect(await portalAddUser(db, send, { ...base(ADMIN), email: "root@bimacreative.tech", name: null, odoo: {} })).toEqual({
      ok: false,
      reason: "precondition",
      detail: "email_other_tenant",
    });
    expect(await portalSetUserEnabled(db, send, { ...base(ADMIN), userId: adminRowId, enabled: false })).toEqual({ ok: false, reason: "authz", denial: "self_action" });
    expect(await portalChangeAccess(db, send, { ...base(ADMIN), userId: adminRowId, odoo: {} })).toEqual({ ok: false, reason: "authz", denial: "self_action" });
    for (const call of [
      portalSetUserEnabled(db, send, { ...base(ADMIN), userId: staffInAcmeId, enabled: false }),
      portalPasswordReset(db, send, { ...base(ADMIN), userId: staffInAcmeId }),
      portalChangeAccess(db, send, { ...base(ADMIN), userId: staffInAcmeId, odoo: {} }),
    ]) {
      expect(await call).toEqual({ ok: false, reason: "authz", denial: "role_not_allowed" });
    }
    // Aktor yang barisnya disabled (sesi masih hidup) → ditolak.
    await db.update(users).set({ status: "disabled" }).where(eq(users.id, adminRowId));
    expect(await portalPasswordReset(db, send, { ...base(ADMIN), userId: budiId })).toEqual({ ok: false, reason: "authz", denial: "actor_disabled" });
    await db.update(users).set({ status: "active" }).where(eq(users.id, adminRowId));
    expect(await jobs()).toBe(j0);
    // Kontrol positif: reset password & nonaktifkan tenant-user sendiri diterima.
    expect((await portalPasswordReset(db, send, { ...base(ADMIN), userId: budiId })).ok).toBe(true);
  });

  it("batas user plan (odoo-shared-s, 5): user invited/active + job yang sedang diproses; penuh → plan_limit + audit; paralel aman", async () => {
    await ageActorRate();
    const shared = (await db.select().from(plans).where(eq(plans.code, "odoo-shared-s")))[0]!;
    expect(shared.maxUsers).toBe(5);
    const SUPER_BILLING = { actor: SUPER, meta: META, instance: "prod" as const, allowedTypes: ALL, send };
    expect(await createSubscription(db, SUPER_BILLING, { clientId: acmeId, planId: shared.id })).toMatchObject({ ok: true });
    // admin + budi + staf(drift, active) + sari (job kc_user_ensure masih queued) = 4
    expect(await countTenantSeats(db, acmeId)).toBe(4);
    // Paralel 3 tambah pada sisa 1 kursi → tepat satu diterima.
    const par = await Promise.all(
      ["p1", "p2", "p3"].map((n) => portalAddUser(db, send, { ...base(ADMIN), email: `${n}@acme.co.id`, name: null, odoo: {} })),
    );
    expect(par.filter((r) => r.ok)).toHaveLength(1);
    expect(par.filter((r) => !r.ok)).toEqual([
      { ok: false, reason: "precondition", detail: "plan_limit" },
      { ok: false, reason: "precondition", detail: "plan_limit" },
    ]);
    expect(await countTenantSeats(db, acmeId)).toBe(5);
    const rej = (await rejected("user.add")).filter((x) => (x.metadata as { detail?: string }).detail === "plan_limit");
    expect(rej).toHaveLength(2);
    expect(rej.every((x) => x.clientId === acmeId && !/p[123]@/.test(JSON.stringify(x.metadata)))).toBe(true);
    // Nonaktifkan budi (bukan kursi baru) diterima; mengaktifkan kembali saat penuh → plan_limit.
    await ageActorRate();
    expect(await portalSetUserEnabled(db, send, { ...base(ADMIN), userId: budiId, enabled: false })).toMatchObject({ ok: true });
    await db.update(users).set({ status: "disabled" }).where(eq(users.id, budiId)); // (rekonsiliasi RESULT disimulasikan)
    await db.execute(sql`UPDATE provision_jobs SET status = 'succeeded' WHERE type = 'kc_user_set_enabled'`);
    expect(await countTenantSeats(db, acmeId)).toBe(4);
    expect(await portalAddUser(db, send, { ...base(ADMIN), email: "p4@acme.co.id", name: null, odoo: {} })).toMatchObject({ ok: true });
    expect(await portalSetUserEnabled(db, send, { ...base(ADMIN), userId: budiId, enabled: true, odoo: {} })).toEqual({
      ok: false,
      reason: "precondition",
      detail: "plan_limit",
    });
    // Job undangan yang gagal membebaskan kursi.
    await db.execute(sql`UPDATE provision_jobs SET status = 'failed' WHERE type = 'kc_user_ensure' AND payload -> 'args' ->> 'email' = 'p4@acme.co.id'`);
    expect(await portalSetUserEnabled(db, send, { ...base(ADMIN), userId: budiId, enabled: true, odoo: {} })).toMatchObject({ ok: true });
    const ok = (await db.select().from(auditLogs).where(and(eq(auditLogs.action, "user.enable"), eq(auditLogs.result, "success"))))[0]!;
    expect(ok.metadata).toMatchObject({ plan_limit: { kind: "limited", plan: "odoo-shared-s", max_users: 5 }, channel: "portal" });
    // Superadmin (/users) tidak dibatasi plan (kanal platform).
    expect(await addUser(db, send, { ...base(SUPER), clientId: acmeId, email: "extra@acme.co.id", name: null, cpRole: "client_user", odoo: {} })).toMatchObject({ ok: true });
  });

  it("query portal hanya data tenant sendiri; cakupan dari users.client_id (bukan input)", async () => {
    await db.insert(domains).values([
      { clientId: acmeId, fqdn: "erp.acme.example", verificationToken: "t1", purpose: "odoo", environmentId: envAcme },
      { clientId: betaId, fqdn: "erp.beta.example", verificationToken: "t2", purpose: "odoo" },
    ]);
    await db.insert(invoices).values([
      { number: "INV/2026/10/9001", clientId: acmeId, amount: "100", dueAt: new Date("2026-10-20T00:00:00Z") },
      { number: "INV/2026/10/9002", clientId: betaId, amount: "200", dueAt: new Date("2026-10-20T00:00:00Z") },
    ]);
    const id = await loadPortalIdentity(db, "acme-admin-sub");
    const scope = decidePortalScope(id.user, id.tenant);
    expect(scope.kind).toBe("ok");
    if (scope.kind !== "ok") return;
    expect(scope.tenant.id).toBe(acmeId);
    const cid = scope.tenant.id;
    expect((await portalUsers(db, cid)).every((u) => u.email !== "u@beta.co.id")).toBe(true);
    expect((await portalEnvironments(db, cid)).map((e) => e.id)).toEqual([envAcme]);
    expect((await portalDomains(db, cid)).map((d) => d.fqdn)).toEqual(["erp.acme.example"]);
    expect((await portalOpenInvoices(db, cid)).map((i) => i.number)).toEqual(["INV/2026/10/9001"]);
    expect((await portalSubscriptions(db, cid)).map((s) => s.status)).toEqual(["implementation"]);
    expect((await portalAccess(db, cid)).every((a) => a.environmentId === envAcme)).toBe(true);
    // User tanpa tenant / staf platform → unbound; tidak ada data.
    const legacy = await loadPortalIdentity(db, "legacy-sub");
    expect(decidePortalScope(legacy.user, legacy.tenant)).toEqual({ kind: "unbound" });
    const staff = await loadPortalIdentity(db, "super-sub");
    expect(decidePortalScope(staff.user, staff.tenant)).toEqual({ kind: "unbound" });
    expect(decidePortalScope((await loadPortalIdentity(db, "nobody")).user, null)).toEqual({ kind: "unbound" });
  });
});
