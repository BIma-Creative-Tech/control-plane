/**
 * Integrasi SaaS Fase 1 W5 (Tenant): onboarding satu form → SATU rantai (tipe lama + Fase 1) dengan dispatcher PALSU,
 * environment_id langkah tipe lama + indeks satu-aktif (environment, type), atomisitas (slug/host/email/kuota),
 * cek host SSO saat dispatch, ulangi dari langkah gagal, suspend/resume, kc_realm_sync plan/apply, query audit.
 * Postgres SEKALI PAKAI (TEST_DATABASE_URL; skema di-DROP).
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { and, eq, inArray, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { PgBoss, fromDrizzle } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db } from "@/db/client";
import { ensureInitialPlans } from "@/db/plans";
import { ensurePlatformTenant } from "@/db/platform";
import { auditLogs, clients, environments, plans, provisionJobs, subscriptions, tenantUserAccess, users } from "@/db/schema";
import { listClientChains, listRealmSyncJobs, listUnboundUsers, queryAudit } from "@/db/tenant-queries";
import { enqueueChain } from "@/jobs/chain";
import { INFRA_JOB_QUEUE_OPTIONS, QUEUE_INFRA_JOB } from "@/jobs/queue";
import type { Actor, SendFn } from "@/jobs/service";
import { onboardTenant, requestRealmSync, retryChainFrom, setTenantState, syncTenant } from "@/jobs/tenants";
import { parseAuditParams } from "@/lib/audit-params";
import { jakartaDate } from "@/lib/billing";
import { BRIDGE_JOB_TYPES, LEGACY_JOB_TYPES, emailHash, type JobFile } from "@/lib/job-contract";
import type { OnboardingInput } from "@/lib/tenant-onboarding";
import { createBridge, type Bridge } from "@/worker/bridge";
import { registerInfraJobWorker } from "@/worker/register";

const URL_ = process.env.TEST_DATABASE_URL;
const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
const META = { ip: "203.0.113.10", requestId: "req-tenants" };

type Res = { state: "succeeded" | "failed"; exit_code: number | null; error_code: string | null; result: Record<string, string> | null; tail: string[] };
type Behavior = (job: JobFile) => Res;
const ok = (result: Record<string, string>): Res => ({ state: "succeeded", exit_code: 0, error_code: null, result, tail: [] });
const fail = (): Res => ({ state: "failed", exit_code: 3, error_code: "script_exit", result: null, tail: ["ERROR: uji"] });

function uuidFrom(v: string): string {
  const x = createHash("sha256").update(v).digest("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-4${x.slice(13, 16)}-8${x.slice(17, 20)}-${x.slice(20, 32)}`;
}
const dbOf = (slug: string, env: string) => `${slug.replace(/-/g, "_")}_${env}`;

/** Dispatcher palsu: RESULT per tipe sesuai kontrak §1/§4 (format nilai v1.1). */
const defaultBehavior: Behavior = (j) => {
  const a = j.args as Record<string, unknown>;
  const email = String(a.email ?? "");
  const kc = uuidFrom(`kc:${email}`);
  switch (j.type) {
    case "kc_org_ensure":
      return ok({ realm: "platform", org: uuidFrom(`org:${String(a.tenant_id)}`), created: "1", changed: "1" });
    case "kc_user_ensure":
      return ok({ realm: "platform", kc_user: kc, created: "1", changed: "1", invite: "1" });
    case "kc_user_set_roles":
      return ok({ kc_user: kc, roles: "client_admin,odoo_access,odoo_admin", changed: "1" });
    case "odoo_user_ensure":
      return ok({ db: dbOf(j.slug, j.env), odoo_user: "7", kc_user: kc, created: "1", changed: "1" });
    case "odoo_db_provision":
      return ok({ db: dbOf(j.slug, j.env), pool: "pool-a", created: "1" });
    case "odoo_route":
      return ok({ route: `${j.slug}-${j.env}.yml`, host: String(a.host), changed: "1" });
    case "odoo_sso_provision":
      return ok({ client: `odoo-${j.slug}-${j.env}`, provider: "3", hosts: (a.hosts as string[]).join(","), changed: "1" });
    case "odoo_tenant_config":
      return ok({ db: dbOf(j.slug, j.env), mode: String(a.tenant_check), changed: "1" });
    case "tenant_suspend":
    case "tenant_resume":
      return ok({ route: `${j.slug}-${j.env}.yml`, state: j.type === "tenant_suspend" ? "suspended" : "active", changed: "1" });
    case "kc_realm_sync":
      return ok(j.dry_run ? { realm: "platform", changed: "3", mode: "plan", blockers: "0" } : { realm: "platform", changed: "3", mode: "apply" });
    default:
      return ok({ changed: "0" });
  }
};

async function atomicWrite(dir: string, name: string, body: unknown) {
  const tmp = path.join(dir, `.${name}.tmp`);
  await writeFile(tmp, JSON.stringify(body));
  await rename(tmp, path.join(dir, name));
}

async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, ms = 30_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe.skipIf(!URL_)("Tenant: onboarding/suspend/retry/realm ⇄ dispatcher palsu (Postgres nyata)", () => {
  let db: Db;
  let pool: { end: () => Promise<void> };
  let workerBoss: PgBoss;
  let webBoss: PgBoss;
  let send: SendFn;
  let root: string;
  let bridge: Bridge;
  let behave: Behavior = defaultBehavior;
  const seen: JobFile[] = [];
  let platformId: string;
  let SUPER: Actor;
  let OPS: Actor;
  const ALL = [...BRIDGE_JOB_TYPES];
  const svc = () => ({ instance: "prod" as const, allowedTypes: ALL, actor: SUPER, meta: META });

  async function fakeDispatchOnce() {
    const newDir = path.join(root, "spool", "new");
    for (const name of (await readdir(newDir)).sort()) {
      await rename(path.join(newDir, name), path.join(root, "work", name));
      const job = JSON.parse(await readFile(path.join(root, "work", name), "utf8")) as JobFile;
      seen.push(job);
      const b = behave(job);
      const t = new Date().toISOString();
      await atomicWrite(path.join(root, "results"), name, { v: 1, job_id: job.job_id, ...b, started_at: t, finished_at: t, duration_ms: 3 });
    }
  }
  const jobsOf = async (ids: string[]) => db.select().from(provisionJobs).where(inArray(provisionJobs.id, ids));
  const settleAll = async (ids: string[]) =>
    waitFor(async () => {
      await fakeDispatchOnce();
      await bridge.tick();
      const rows = await jobsOf(ids);
      return rows.every((r) => ["succeeded", "failed", "cancelled"].includes(r.status)) ? rows : null;
    });
  const ordered = (rows: (typeof provisionJobs.$inferSelect)[], ids: string[]) => ids.map((id) => rows.find((r) => r.id === id)!);
  /** Kuota odoo_db_provision 3/hari: geser job lama ke masa lalu agar uji berikutnya tidak terhalang. */
  const ageDbProvisions = () => db.execute(sql`UPDATE provision_jobs SET created_at = now() - interval '2 days' WHERE type = 'odoo_db_provision'`);
  /** Rate limit aktor 10 rantai/menit (kuota P1): geser job yang sudah ada 2 menit ke belakang. */
  const ageActorRate = () => db.execute(sql`UPDATE provision_jobs SET created_at = created_at - interval '2 minutes'`);
  const form = (slug: string, patch: Partial<OnboardingInput> = {}): OnboardingInput => ({
    slug,
    name: `PT ${slug}`,
    brand: null,
    adminEmail: `admin@${slug}.co.id`,
    adminName: "Admin Tenant",
    envs: [{ kind: "prod", host: `${slug}.erp.bimacreative.tech` }],
    planId: null,
    ...patch,
  });

  beforeAll(async () => {
    ({ db, pool } = createDb(URL_!, { max: 4, applicationName: "cp-int-tenants" }));
    await db.execute(sql`DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA IF EXISTS pgboss CASCADE; CREATE SCHEMA public;`);
    await migrate(db, { migrationsFolder: "./drizzle" });
    platformId = (await ensurePlatformTenant(db)).id;

    workerBoss = new PgBoss({ connectionString: URL_!, schema: "pgboss", max: 2 });
    workerBoss.on("error", () => undefined);
    await workerBoss.start();
    await workerBoss.createQueue(QUEUE_INFRA_JOB, INFRA_JOB_QUEUE_OPTIONS);
    webBoss = new PgBoss({ connectionString: URL_!, schema: "pgboss", max: 1, migrate: false, supervise: false, schedule: false });
    webBoss.on("error", () => undefined);
    await webBoss.start();
    send = (tx, id) => webBoss.send(QUEUE_INFRA_JOB, { provisionJobId: id }, { db: fromDrizzle(tx, sql), ...INFRA_JOB_QUEUE_OPTIONS });

    root = await mkdtemp(path.join(tmpdir(), "cp-int-tenants-"));
    for (const d of ["spool/tmp", "spool/new", "work", "results"]) await mkdir(path.join(root, d), { recursive: true });
    bridge = createBridge({ db, instance: "prod", spoolDir: path.join(root, "spool"), resultsDir: path.join(root, "results"), queueGraceSeconds: 900, logger: quiet });
    await registerInfraJobWorker(workerBoss, bridge, quiet, { pollingIntervalSeconds: 0.5 });

    const [sa] = await db.insert(users).values({ keycloakSub: "super-sub", role: "superadmin", clientId: platformId }).returning();
    const [op] = await db.insert(users).values({ keycloakSub: "ops-sub", role: "ops", clientId: platformId }).returning();
    // Baris lama tanpa tenant (kandidat adopsi) + user tenant lain (aturan email F1).
    await db.insert(users).values({ keycloakSub: "legacy-sub", email: "legacy@bimacreative.tech", role: "ops" });
    SUPER = { sub: "super-sub", userId: sa!.id, roles: ["superadmin"] };
    OPS = { sub: "ops-sub", userId: op!.id, roles: ["ops"] };
  }, 60_000);

  afterAll(async () => {
    await workerBoss?.stop({ graceful: false, timeout: 2000 }).catch(() => undefined);
    await webBoss?.stop({ graceful: false, timeout: 2000 }).catch(() => undefined);
    await pool?.end();
    if (root) await rm(root, { recursive: true, force: true });
  });

  let acmeId: string;

  it("onboarding prod+demo: tenant + 2 environment + SATU rantai 14 langkah, urutan persis, rekonsiliasi lengkap", async () => {
    seen.length = 0;
    const r = await onboardTenant(db, send, {
      ...svc(),
      form: form("acme-co", { brand: "Acme", envs: [{ kind: "prod", host: "acme-co.erp.bimacreative.tech" }, { kind: "demo", host: "acme-demo.erp.bimacreative.tech" }] }),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    acmeId = r.clientId;
    expect(r.jobIds).toHaveLength(14);
    const c = (await db.select().from(clients).where(eq(clients.id, acmeId)))[0]!;
    expect(c).toMatchObject({ slug: "acme-co", name: "PT acme-co", brand: "Acme", status: "active", isPlatform: false });
    const envRows = await db.select().from(environments).where(eq(environments.clientId, acmeId));
    const envId = (k: string) => envRows.find((e) => e.kind === k)!.id;
    expect(envRows.map((e) => [e.kind, e.dbName, e.url, e.odooInstance, e.dbStatus]).sort()).toEqual([
      ["demo", "acme_co_demo", "https://acme-demo.erp.bimacreative.tech", "pool-a", "absent"],
      ["prod", "acme_co_prod", "https://acme-co.erp.bimacreative.tech", "pool-a", "absent"],
    ]);

    const before = ordered(await jobsOf(r.jobIds), r.jobIds);
    expect(new Set(before.map((j) => j.chainId)).size).toBe(1);
    // environment_id HANYA untuk tipe lama (ikut provision_jobs_one_active_uq), diturunkan server dari (client, env).
    for (const j of before) {
      if ((LEGACY_JOB_TYPES as readonly string[]).includes(j.type)) expect(j.environmentId).toBe(envId(j.env!));
      else expect(j.environmentId).toBeNull();
      expect(j.clientId).toBe(acmeId);
    }
    expect(before[0]!.payload).toEqual({ slug: "acme-co", args: { tenant_id: acmeId } });
    expect(before.find((j) => j.type === "kc_user_ensure")!.payload).toEqual({
      slug: "acme-co",
      args: { email: "admin@acme-co.co.id", tenant_id: acmeId, invite: true, name: "Admin Tenant" },
    });
    // Audit: tenant.create (prelude) + tenant.onboard — tanpa email mentah.
    const aud = await db.select().from(auditLogs).where(and(eq(auditLogs.clientId, acmeId), inArray(auditLogs.action, ["tenant.create", "tenant.onboard"])));
    expect(aud.map((a) => a.action).sort()).toEqual(["tenant.create", "tenant.onboard"]);
    expect(aud.every((a) => !JSON.stringify(a.metadata).includes("admin@"))).toBe(true);
    expect(aud.find((a) => a.action === "tenant.onboard")!.metadata).toMatchObject({ email_hash: emailHash("admin@acme-co.co.id"), envs: ["prod", "demo"] });

    const rows = ordered(await settleAll(r.jobIds), r.jobIds);
    expect(rows.every((x) => x.status === "succeeded")).toBe(true);
    expect(seen.map((j) => `${j.type}@${j.env}`)).toEqual([
      "kc_org_ensure@prod",
      "odoo_db_provision@prod",
      "odoo_route@prod",
      "odoo_sso_provision@prod",
      "odoo_tenant_config@prod",
      "odoo_db_provision@demo",
      "odoo_route@demo",
      "odoo_sso_provision@demo",
      "odoo_tenant_config@demo",
      "kc_user_ensure@prod",
      "kc_user_set_roles@prod",
      "kc_user_set_roles@demo",
      "odoo_user_ensure@prod",
      "odoo_user_ensure@demo",
    ]);
    expect(seen.every((j) => j.slug === "acme-co" && j.actor === "user:super-sub" && !j.dry_run)).toBe(true);

    // Rekonsiliasi: environments dari RESULT tipe lama, org, user admin, akses Odoo admin per env, tenant_check.
    const envAfter = await db.select().from(environments).where(eq(environments.clientId, acmeId));
    for (const e of envAfter) {
      expect(e).toMatchObject({ dbStatus: "provisioned", routeStatus: "active", ssoStatus: "active", ssoClientId: `odoo-acme-co-${e.kind}`, ssoProviderId: 3 });
      expect(e.host).toBe(e.kind === "prod" ? "acme-co.erp.bimacreative.tech" : "acme-demo.erp.bimacreative.tech");
    }
    expect((await db.select().from(clients).where(eq(clients.id, acmeId)))[0]!.kcOrgId).toBe(uuidFrom(`org:${acmeId}`));
    const admin = (await db.select().from(users).where(eq(users.clientId, acmeId)))[0]!;
    expect(admin).toMatchObject({ email: "admin@acme-co.co.id", role: "client_admin", status: "invited", invitedBy: SUPER.userId });
    const tua = await db.select().from(tenantUserAccess).where(eq(tenantUserAccess.email, "admin@acme-co.co.id"));
    expect(tua).toHaveLength(2);
    expect(tua.every((t) => t.isTenantAdmin && t.status === "active")).toBe(true);
    // Migrasi 0005: RESULT mode odoo_tenant_config → environments.tenant_check (rekonsiliasi worker).
    expect(envAfter.map((e) => e.tenantCheck)).toEqual(["compat", "compat"]);
    const chains = await listClientChains(db, acmeId);
    expect(chains).toHaveLength(1);
    expect(chains[0]!.steps.map((s) => s.id)).toEqual(r.jobIds);
  });

  it("atomik: slug sudah ada / host dipakai / email tenant lain / email lama tanpa tenant / ops → ditolak tanpa baris tersisa", async () => {
    const nClients = async () => (await db.select().from(clients)).length;
    const nJobs = async () => (await db.select().from(provisionJobs)).length;
    const [c0, j0] = [await nClients(), await nJobs()];
    expect(await onboardTenant(db, send, { ...svc(), form: form("acme-co", { adminEmail: "baru@acme-co.co.id", envs: [{ kind: "prod", host: "acme-x.erp.bimacreative.tech" }] }) })).toEqual({
      ok: false,
      reason: "exists",
    });
    expect(await onboardTenant(db, send, { ...svc(), form: form("beta-co", { envs: [{ kind: "prod", host: "acme-demo.erp.bimacreative.tech" }] }) })).toEqual({
      ok: false,
      reason: "precondition",
      detail: "host_taken",
    });
    expect(await onboardTenant(db, send, { ...svc(), form: form("beta-co", { adminEmail: "admin@acme-co.co.id" }) })).toEqual({
      ok: false,
      reason: "binding",
      conflict: "email_other_tenant",
    });
    expect(await onboardTenant(db, send, { ...svc(), form: form("beta-co", { adminEmail: "legacy@bimacreative.tech" }) })).toEqual({
      ok: false,
      reason: "binding",
      conflict: "email_unbound",
    });
    expect(await onboardTenant(db, send, { ...svc(), actor: OPS, form: form("beta-co") })).toEqual({ ok: false, reason: "forbidden" });
    // Instance tanpa tipe onboarding di allowlist → fitur nonaktif.
    expect(await onboardTenant(db, send, { ...svc(), allowedTypes: [...LEGACY_JOB_TYPES], form: form("beta-co") })).toEqual({ ok: false, reason: "disabled" });
    expect(await nClients()).toBe(c0);
    expect(await nJobs()).toBe(j0);
    // Penolakan diaudit; baris tenant di-rollback → audit tanpa client_id.
    const rej = await db.select().from(auditLogs).where(and(eq(auditLogs.action, "tenant.onboard"), eq(auditLogs.result, "rejected")));
    expect(rej.length).toBeGreaterThanOrEqual(5);
    expect(rej.every((a) => a.clientId === null && !/admin@|legacy@/.test(JSON.stringify(a.metadata)))).toBe(true);
    expect(rej.map((a) => (a.metadata as { reason?: string }).reason)).toEqual(expect.arrayContaining(["exists", "precondition", "binding", "forbidden"]));
  });

  it("kuota rantai: odoo_db_provision 3/hari (2 terpakai) → prod+demo ditolak utuh, prod saja diterima", async () => {
    const c0 = (await db.select().from(clients)).length;
    const r = await onboardTenant(db, send, {
      ...svc(),
      form: form("beta-co", { envs: [{ kind: "prod", host: "beta-co.erp.bimacreative.tech" }, { kind: "demo", host: "beta-demo.erp.bimacreative.tech" }] }),
    });
    expect(r).toEqual({ ok: false, reason: "quota", violation: "db_provision_day" });
    expect((await db.select().from(clients)).length).toBe(c0);
    await ageDbProvisions();
  });

  it("langkah gagal → chain_aborted; Ulangi dari langkah gagal = rantai baru (parent_job_id) dan selesai", async () => {
    seen.length = 0;
    behave = (j) => (j.type === "odoo_route" ? fail() : defaultBehavior(j));
    const r = await onboardTenant(db, send, { ...svc(), form: form("gamma-co") });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const rows = ordered(await settleAll(r.jobIds), r.jobIds);
    expect(rows.map((x) => x.status)).toEqual(["succeeded", "succeeded", "failed", "cancelled", "cancelled", "cancelled", "cancelled", "cancelled"]);
    expect(rows.slice(3).every((x) => x.errorCode === "chain_aborted")).toBe(true);
    expect(seen.map((j) => j.type)).toEqual(["kc_org_ensure", "odoo_db_provision", "odoo_route"]);
    const routeJob = rows[2]!;
    behave = defaultBehavior;

    // Prasyarat: langkah sukses / langkah chain_aborted tidak bisa jadi titik ulang; ops ditolak.
    expect(await retryChainFrom(db, send, { ...svc(), jobId: rows[1]!.id })).toEqual({ ok: false, reason: "retry", issue: "not_failed" });
    expect(await retryChainFrom(db, send, { ...svc(), jobId: rows[3]!.id })).toEqual({ ok: false, reason: "retry", issue: "not_failed" });
    expect(await retryChainFrom(db, send, { ...svc(), actor: OPS, jobId: routeJob.id })).toEqual({ ok: false, reason: "forbidden" });

    seen.length = 0;
    const rr = await retryChainFrom(db, send, { ...svc(), jobId: routeJob.id });
    expect(rr.ok).toBe(true);
    if (!rr.ok) return;
    expect(rr.jobIds).toHaveLength(6);
    const newRows = ordered(await settleAll(rr.jobIds), rr.jobIds);
    expect(newRows.every((x) => x.status === "succeeded")).toBe(true);
    expect(newRows[0]!.parentJobId).toBe(routeJob.id);
    expect(newRows[0]!.chainId).not.toBe(routeJob.chainId);
    expect(newRows[0]!.environmentId).toBe(routeJob.environmentId);
    expect(seen.map((j) => j.type)).toEqual(["odoo_route", "odoo_sso_provision", "odoo_tenant_config", "kc_user_ensure", "kc_user_set_roles", "odoo_user_ensure"]);
    const env = (await db.select().from(environments).where(eq(environments.clientId, r.clientId)))[0]!;
    expect(env).toMatchObject({ dbStatus: "provisioned", routeStatus: "active", ssoStatus: "active" });
    const audit = await db.select().from(auditLogs).where(and(eq(auditLogs.action, "chain.retry"), eq(auditLogs.result, "success")));
    expect(audit).toHaveLength(1);
    expect(audit[0]!.metadata).toMatchObject({ from_job_id: routeJob.id, from_chain_id: routeJob.chainId, retry_of: routeJob.id, chain_id: rr.chainId });
    // Kunci idempotency langkah lama yang diulang dilepas ke rantai baru; hanya kc_org_ensure (tidak diulang) memegangnya.
    const oldKeys = await db.select().from(provisionJobs).where(and(eq(provisionJobs.chainId, routeJob.chainId!), sql`${provisionJobs.idempotencyKey} IS NOT NULL`));
    expect(oldKeys.map((k) => k.type)).toEqual(["kc_org_ensure"]);
  });

  it("rantai tipe lama: job aktif (environment, type) dipakai ulang / args beda → duplicate; host SSO di luar route → precondition; aktor tanpa jobs:odoo → forbidden; sso_user ditolak", async () => {
    const [gamma] = await db.select().from(clients).where(eq(clients.slug, "gamma-co"));
    const env = (await db.select().from(environments).where(eq(environments.clientId, gamma!.id)))[0]!;
    const [manual] = await db
      .insert(provisionJobs)
      .values({
        type: "odoo_route",
        status: "running",
        clientId: gamma!.id,
        environmentId: env.id,
        env: "prod",
        payload: { slug: "gamma-co", args: { host: "gamma-co.erp.bimacreative.tech", remove: false } },
        actor: "user:super-sub",
      })
      .returning();
    const input = (steps: Parameters<typeof enqueueChain>[2]["steps"], actor = SUPER) => ({
      ...svc(),
      actor,
      client: { id: gamma!.id, slug: "gamma-co" },
      steps,
      audit: { action: "test.chain", targetType: "client", targetId: gamma!.id, metadata: {} },
    });
    const same = await enqueueChain(db, send, input([{ type: "odoo_route", env: "prod", args: { host: "gamma-co.erp.bimacreative.tech", remove: false } }]));
    expect(same).toMatchObject({ ok: true, jobIds: [manual!.id], reused: 1 });
    const diff = await enqueueChain(db, send, input([{ type: "odoo_route", env: "prod", args: { remove: false } }]));
    expect(diff).toMatchObject({ ok: false, reason: "duplicate", existingJobId: manual!.id });
    await db.update(provisionJobs).set({ status: "succeeded" }).where(eq(provisionJobs.id, manual!.id));

    // Route DB aktif dengan host gamma-co…; SSO untuk host lain (tanpa langkah route di rantai) → precondition.
    const sso = await enqueueChain(
      db,
      send,
      input([{ type: "odoo_sso_provision", env: "prod", args: { hosts: ["other.erp.bimacreative.tech"], rotate_secret: false, skip_smoke: false } }]),
    );
    expect(sso).toMatchObject({ ok: false, reason: "precondition", detail: "host_not_in_route", step: 0 });
    // Env yang tidak ada untuk tenant ini.
    const noEnv = await enqueueChain(db, send, input([{ type: "odoo_route", env: "demo", args: { host: "gamma-demo.erp.bimacreative.tech", remove: false } }]));
    expect(noEnv).toMatchObject({ ok: false, reason: "precondition", detail: "env_missing" });
    const cadmin: Actor = { sub: "x-sub", userId: null, roles: ["client_admin"] };
    expect(await enqueueChain(db, send, input([{ type: "odoo_route", env: "prod", args: { remove: false } }], cadmin))).toMatchObject({ ok: false, reason: "forbidden" });
    // rotate_secret di rantai = aksi berisiko: ops (jobs:odoo tanpa jobs:odoo_admin) ditolak.
    expect(
      await enqueueChain(
        db,
        send,
        input([{ type: "odoo_sso_provision", env: "prod", args: { hosts: ["gamma-co.erp.bimacreative.tech"], rotate_secret: true, skip_smoke: false } }], OPS),
      ),
    ).toMatchObject({ ok: false, reason: "forbidden" });
    expect(
      await enqueueChain(db, send, input([{ type: "odoo_sso_user", env: "prod", args: { action: "grant", email: "a@gamma.co.id", admin: false, create_kc: false } }])),
    ).toMatchObject({ ok: false, reason: "invalid", issue: "type_not_allowed" });
  });

  it("worker: host SSO dicek ulang saat dispatch — route melaporkan host lain → odoo_sso_provision rejected_validation, sisa rantai chain_aborted", async () => {
    seen.length = 0;
    behave = (j) => (j.type === "odoo_route" ? ok({ route: `${j.slug}-${j.env}.yml`, host: "lain.erp.bimacreative.tech", changed: "1" }) : defaultBehavior(j));
    const r = await onboardTenant(db, send, { ...svc(), form: form("delta-co") });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const rows = ordered(await settleAll(r.jobIds), r.jobIds);
    behave = defaultBehavior;
    expect(rows.map((x) => x.status).slice(0, 4)).toEqual(["succeeded", "succeeded", "succeeded", "failed"]);
    expect(rows[3]).toMatchObject({ type: "odoo_sso_provision", errorCode: "rejected_validation", error: "ditolak worker: host_not_in_route" });
    expect(rows.slice(4).every((x) => x.status === "cancelled" && x.errorCode === "chain_aborted")).toBe(true);
    // File job SSO tidak pernah ditulis ke spool.
    expect(seen.map((j) => j.type)).toEqual(["kc_org_ensure", "odoo_db_provision", "odoo_route"]);
    await ageDbProvisions();
  });

  it("ulangi: hanya rantai tenant/realm; user target kini disabled / akun aktor sendiri → ditolak (tidak memberi hak lagi)", async () => {
    await ageActorRate();
    const [gamma] = await db.select().from(clients).where(eq(clients.slug, "gamma-co"));
    // Rantai non-tenant (mis. aksi Users) yang gagal → tidak bisa diulang dari halaman tenant.
    behave = (j) => (j.type === "kc_user_action_email" ? fail() : defaultBehavior(j));
    const uc = await enqueueChain(db, send, {
      ...svc(),
      client: { id: gamma!.id, slug: "gamma-co" },
      steps: [{ type: "kc_user_action_email", env: "prod", args: { email: "admin@gamma-co.co.id", action: "UPDATE_PASSWORD" } }],
      audit: { action: "user.password_reset", targetType: "user", targetId: null, metadata: {} },
    });
    expect(uc.ok).toBe(true);
    if (!uc.ok) return;
    await settleAll(uc.jobIds);
    expect(await retryChainFrom(db, send, { ...svc(), jobId: uc.jobIds[0]! })).toEqual({ ok: false, reason: "retry", issue: "origin" });

    // Onboarding eps-co: odoo_user_ensure gagal → admin kemudian DINONAKTIFKAN → ulang ditolak target_disabled.
    behave = (j) => (j.type === "odoo_user_ensure" ? fail() : defaultBehavior(j));
    const r = await onboardTenant(db, send, { ...svc(), form: form("eps-co") });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const rows = ordered(await settleAll(r.jobIds), r.jobIds);
    behave = defaultBehavior;
    const last = rows[rows.length - 1]!;
    expect(last).toMatchObject({ type: "odoo_user_ensure", status: "failed" });
    const admin = (await db.select().from(users).where(eq(users.clientId, r.clientId)))[0]!;
    await db.update(users).set({ status: "disabled" }).where(eq(users.id, admin.id));
    expect(await retryChainFrom(db, send, { ...svc(), jobId: last.id })).toEqual({ ok: false, reason: "retry", issue: "target_disabled" });
    // Akun aktor sendiri sebagai target → ditolak.
    await db.update(users).set({ status: "invited" }).where(eq(users.id, admin.id));
    await db.update(users).set({ email: "admin@eps-co.co.id" }).where(eq(users.id, SUPER.userId!));
    expect(await retryChainFrom(db, send, { ...svc(), jobId: last.id })).toEqual({ ok: false, reason: "retry", issue: "self_target" });
    await db.update(users).set({ email: null }).where(eq(users.id, SUPER.userId!));
    const ok2 = await retryChainFrom(db, send, { ...svc(), jobId: last.id });
    expect(ok2.ok).toBe(true);
    if (ok2.ok) expect((await settleAll(ok2.jobIds)).every((x) => x.status === "succeeded")).toBe(true);
    const chains = await listClientChains(db, r.clientId);
    expect(chains.map((c) => c.origin)).toEqual(["chain.retry", "tenant.onboard"]);
    const rej = await db.select().from(auditLogs).where(and(eq(auditLogs.action, "chain.retry"), eq(auditLogs.result, "rejected")));
    expect(rej.map((a) => (a.metadata as { issue?: string }).issue)).toEqual(expect.arrayContaining(["origin", "target_disabled", "self_target"]));
    await ageDbProvisions();
  });

  it("suspend/resume override: konfirmasi slug, satu langkah per env, kebalikan aktif → state_busy, sama aktif → dipakai ulang", async () => {
    await ageActorRate();
    const base = { ...svc(), clientId: acmeId };
    expect(await setTenantState(db, send, { ...base, action: "suspend", confirm: "acme" })).toEqual({ ok: false, reason: "confirm" });
    expect(await setTenantState(db, send, { ...base, action: "suspend", confirm: null })).toEqual({ ok: false, reason: "confirm" });
    expect(await setTenantState(db, send, { ...base, actor: OPS, action: "suspend", confirm: "acme-co" })).toEqual({ ok: false, reason: "forbidden" });
    expect(await setTenantState(db, send, { ...base, clientId: platformId, action: "suspend", confirm: "platform" })).toMatchObject({
      ok: false,
      reason: "invalid",
      issue: "platform_forbidden",
    });
    const rej = await db.select().from(auditLogs).where(and(eq(auditLogs.action, "tenant.suspend"), eq(auditLogs.result, "rejected")));
    expect(rej.map((a) => (a.metadata as { reason?: string }).reason).sort()).toEqual(["confirm", "confirm", "forbidden", "platform"]);

    seen.length = 0;
    const s1 = await setTenantState(db, send, { ...base, action: "suspend", confirm: "acme-co" });
    expect(s1.ok).toBe(true);
    if (!s1.ok) return;
    const s2 = await setTenantState(db, send, { ...base, action: "suspend", confirm: "acme-co" });
    expect(s2.ok && s2.jobIds).toEqual(s1.jobIds);
    expect(await setTenantState(db, send, { ...base, action: "resume", confirm: "acme-co" })).toEqual({ ok: false, reason: "precondition", detail: "state_busy" });
    const rows = ordered(await settleAll(s1.jobIds), s1.jobIds);
    expect(rows.map((x) => `${x.type}@${x.env}:${x.status}`)).toEqual(["tenant_suspend@prod:succeeded", "tenant_suspend@demo:succeeded"]);
    expect(seen.every((j) => j.type === "tenant_suspend" && JSON.stringify(j.args) === "{}")).toBe(true);
    const r1 = await setTenantState(db, send, { ...base, action: "resume", confirm: "acme-co" });
    expect(r1.ok).toBe(true);
    if (r1.ok) await settleAll(r1.jobIds);
  });

  it("sinkronkan tenant: org + tenant_check(mode) per env ber-SSO aktif; ops/platform ditolak; diaudit", async () => {
    await ageActorRate();
    const base = { ...svc(), clientId: acmeId };
    expect(await syncTenant(db, send, { ...base, actor: OPS, tenantCheck: "compat" })).toEqual({ ok: false, reason: "forbidden" });
    expect(await syncTenant(db, send, { ...base, clientId: platformId, tenantCheck: "compat" })).toMatchObject({
      ok: false,
      reason: "invalid",
      issue: "platform_forbidden",
    });
    seen.length = 0;
    const s1 = await syncTenant(db, send, { ...base, tenantCheck: "strict" });
    expect(s1.ok).toBe(true);
    if (!s1.ok) return;
    const rows = ordered(await settleAll(s1.jobIds), s1.jobIds);
    // kuota total 60 job/jam: job uji ini dimundurkan agar tidak memakan jatah tes berikutnya
    await db.update(provisionJobs).set({ createdAt: sql`created_at - interval '2 hours'` }).where(inArray(provisionJobs.id, s1.jobIds));
    expect(rows.map((x) => `${x.type}@${x.env}:${x.status}`)).toEqual([
      "kc_org_ensure@prod:succeeded",
      "odoo_tenant_config@prod:succeeded",
      "odoo_tenant_config@demo:succeeded",
    ]);
    const cfg = seen.filter((j) => j.type === "odoo_tenant_config");
    expect(cfg.length).toBe(2);
    expect(cfg.every((j) => (j.args as { tenant_check?: string }).tenant_check === "strict")).toBe(true);
    const audits = await db.select().from(auditLogs).where(eq(auditLogs.action, "tenant.sync"));
    expect(audits.map((a) => a.result).sort()).toEqual(["rejected", "rejected", "success"]);
  });

  it("kc_realm_sync: apply tanpa rencana → plan_required; rencana dry-run; apply prod wajib ketik realm + approve → approve=true", async () => {
    await ageActorRate();
    const base = svc();
    expect(await requestRealmSync(db, send, { ...base, mode: "apply", confirmRealm: "platform", approveChecked: true })).toEqual({
      ok: false,
      reason: "realm",
      code: "plan_required",
    });
    expect(await requestRealmSync(db, send, { ...base, actor: OPS, mode: "plan" })).toEqual({ ok: false, reason: "forbidden" });

    seen.length = 0;
    const plan = await requestRealmSync(db, send, { ...base, mode: "plan" });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const [pj] = await settleAll(plan.jobIds);
    expect(pj).toMatchObject({ type: "kc_realm_sync", dryRun: true, env: "prod", clientId: platformId, status: "succeeded", idempotencyKey: null });
    expect(seen[0]).toMatchObject({ type: "kc_realm_sync", slug: "platform", env: "prod", dry_run: true, args: {} });

    expect(await requestRealmSync(db, send, { ...base, mode: "apply", confirmRealm: "platform-staging", approveChecked: true })).toEqual({ ok: false, reason: "confirm" });
    expect(await requestRealmSync(db, send, { ...base, mode: "apply", confirmRealm: "platform", approveChecked: false })).toEqual({
      ok: false,
      reason: "realm",
      code: "approve_required",
    });
    seen.length = 0;
    const apply = await requestRealmSync(db, send, { ...base, mode: "apply", confirmRealm: "platform", approveChecked: true });
    expect(apply.ok).toBe(true);
    if (!apply.ok) return;
    const [aj] = await settleAll(apply.jobIds);
    expect(aj).toMatchObject({ dryRun: false, status: "succeeded", idempotencyKey: "kc_realm_sync:platform:prod:realm" });
    expect(seen[0]).toMatchObject({ type: "kc_realm_sync", slug: "platform", dry_run: false, args: { approve: true } });
    const hist = await listRealmSyncJobs(db, platformId);
    expect(hist.map((h) => h.result?.mode)).toEqual(["apply", "plan"]);
    const aud = await db.select().from(auditLogs).where(and(eq(auditLogs.action, "realm.sync_apply"), eq(auditLogs.result, "success")));
    expect(aud[0]!.metadata).toMatchObject({ realm: "platform", env: "prod", approve: true });

    // Rencana berblokir → apply ditolak.
    behave = (j) => (j.type === "kc_realm_sync" ? ok({ realm: "platform", changed: "1", mode: "plan", blockers: "1" }) : defaultBehavior(j));
    const p2 = await requestRealmSync(db, send, { ...base, mode: "plan" });
    if (p2.ok) await settleAll(p2.jobIds);
    behave = defaultBehavior;
    expect(await requestRealmSync(db, send, { ...base, mode: "apply", confirmRealm: "platform", approveChecked: true })).toEqual({
      ok: false,
      reason: "realm",
      code: "plan_required",
    });
    // Kandidat adopsi (baris lama tanpa tenant).
    expect((await listUnboundUsers(db)).map((u) => u.email)).toContain("legacy@bimacreative.tech");
  });

  it("audit: filter aktor (prefix sub) / tenant / aksi (prefix) / hasil / tanggal + paginasi", async () => {
    const all = await queryAudit(db, parseAuditParams({}));
    expect(all.total).toBeGreaterThan(10);
    const byTenant = await queryAudit(db, parseAuditParams({ tenant: "acme-co" }));
    expect(byTenant.rows.length).toBeGreaterThan(0);
    expect(byTenant.rows.every((a) => a.tenant === "acme-co")).toBe(true);
    const byAction = await queryAudit(db, parseAuditParams({ action: "tenant." }));
    expect(byAction.rows.every((a) => a.action.startsWith("tenant."))).toBe(true);
    expect(new Set(byAction.rows.map((a) => a.action))).toEqual(new Set(["tenant.create", "tenant.onboard", "tenant.suspend", "tenant.resume", "tenant.sync"]));
    const byActor = await queryAudit(db, parseAuditParams({ actor: "ops" }));
    expect(byActor.rows.length).toBeGreaterThan(0);
    expect(byActor.rows.every((a) => a.actor === "user:ops-sub")).toBe(true);
    const sys = await queryAudit(db, parseAuditParams({ actor: "system:worker", action: "job.finish" }));
    expect(sys.total).toBeGreaterThan(20);
    const rejected = await queryAudit(db, parseAuditParams({ result: "rejected", action: "tenant.onboard" }));
    expect(rejected.rows.every((a) => a.result === "rejected" && a.tenant === null)).toBe(true);
    const future = await queryAudit(db, parseAuditParams({ from: "2099-01-01" }));
    expect(future.total).toBe(0);
    const today = jakartaDate(new Date()); // N10: filter tanggal = hari WIB
    expect((await queryAudit(db, parseAuditParams({ from: today, to: today }))).total).toBe(all.total);
    const p2 = await queryAudit(db, parseAuditParams({ page: "2" }));
    expect(p2.total).toBe(all.total);
    expect(p2.rows[0]?.id).not.toBe(all.rows[0]?.id);
    // Wildcard LIKE tidak berlaku (starts_with): "%" ditolak parser, "_" tidak cocok sembarang karakter.
    expect((await queryAudit(db, parseAuditParams({ action: "tenant_" }))).total).toBe(0);
  });

  it("onboarding + plan Odoo: langganan implementation di transaksi yang sama; plan non-odoo/tidak aktif/ops → ditolak utuh", async () => {
    await ensureInitialPlans(db);
    await ageDbProvisions();
    await ageActorRate();
    const planOf = async (code: string) => (await db.select().from(plans).where(eq(plans.code, code)))[0]!.id;
    const count = async () => ({ c: (await db.select().from(clients)).length, s: (await db.select().from(subscriptions)).length, j: (await db.select().from(provisionJobs)).length });
    const c0 = await count();
    // Plan layanan mail → plan_inactive; tenant/env/job/langganan tidak tersisa.
    expect(await onboardTenant(db, send, { ...svc(), form: form("zeta-co", { planId: await planOf("mail-5") }) })).toEqual({
      ok: false,
      reason: "precondition",
      detail: "plan_inactive",
    });
    // Plan tidak ada (uuid acak) dan plan nonaktif → plan_inactive.
    expect(await onboardTenant(db, send, { ...svc(), form: form("zeta-co", { planId: "0b0b0b0b-0000-4000-8000-000000000000" }) })).toMatchObject({ detail: "plan_inactive" });
    await db.update(plans).set({ isActive: false }).where(eq(plans.code, "odoo-shared-m"));
    expect(await onboardTenant(db, send, { ...svc(), form: form("zeta-co", { planId: await planOf("odoo-shared-m") }) })).toMatchObject({ detail: "plan_inactive" });
    await db.update(plans).set({ isActive: true }).where(eq(plans.code, "odoo-shared-m"));
    expect(await count()).toEqual(c0);
    // ops: clients:manage tidak ada → forbidden sebelum apa pun.
    expect(await onboardTenant(db, send, { ...svc(), actor: OPS, form: form("zeta-co", { planId: await planOf("odoo-shared-s") }) })).toEqual({ ok: false, reason: "forbidden" });

    const r = await onboardTenant(db, send, { ...svc(), form: form("zeta-co", { planId: await planOf("odoo-shared-s") }) });
    expect(r.ok).toBe(true);
    const zid = (r as { clientId: string }).clientId;
    const subs = await db.select().from(subscriptions).where(eq(subscriptions.clientId, zid));
    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatchObject({ status: "implementation", planId: await planOf("odoo-shared-s"), priceAmount: null });
    const created = await db.select().from(auditLogs).where(and(eq(auditLogs.action, "subscription.create"), eq(auditLogs.clientId, zid)));
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ result: "success", actor: "user:super-sub", targetId: subs[0]!.id });
    const onboard = (await db.select().from(auditLogs).where(and(eq(auditLogs.action, "tenant.onboard"), eq(auditLogs.clientId, zid))))[0]!;
    expect(onboard.metadata).toMatchObject({ plan_id: await planOf("odoo-shared-s") });
  });

  it("QA N1/N3: rantai realm sync dan suspend/resume yang gagal TIDAK bisa diulang dari halaman tenant (origin)", async () => {
    await ageActorRate();
    behave = (j) => (j.type === "kc_realm_sync" || j.type === "tenant_suspend" ? fail() : defaultBehavior(j));
    const plan = await requestRealmSync(db, send, { ...svc(), mode: "plan" });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const [pj] = await settleAll(plan.jobIds);
    expect(pj!.status).toBe("failed");
    expect(await retryChainFrom(db, send, { ...svc(), jobId: pj!.id })).toEqual({ ok: false, reason: "retry", issue: "origin" });

    const [eps] = await db.select().from(clients).where(eq(clients.slug, "eps-co"));
    const sus = await setTenantState(db, send, { ...svc(), clientId: eps!.id, action: "suspend", confirm: "eps-co" });
    expect(sus.ok).toBe(true);
    if (!sus.ok) return;
    const rows = await settleAll(sus.jobIds);
    expect(rows.every((r) => r.status === "failed")).toBe(true);
    expect(await retryChainFrom(db, send, { ...svc(), jobId: rows[0]!.id })).toEqual({ ok: false, reason: "retry", issue: "origin" });
    behave = defaultBehavior;
    // Ulang manual lewat tombol berkonfirmasi slug tetap bisa.
    const again = await setTenantState(db, send, { ...svc(), clientId: eps!.id, action: "suspend", confirm: "eps-co" });
    expect(again.ok).toBe(true);
    const rej = await db.select().from(auditLogs).where(and(eq(auditLogs.action, "chain.retry"), eq(auditLogs.result, "rejected")));
    expect(rej.filter((a) => (a.metadata as { issue?: string }).issue === "origin").length).toBeGreaterThanOrEqual(3);
  });
});
