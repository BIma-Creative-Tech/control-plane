/**
 * Integrasi migrasi prod M8 — "Daftarkan tenant yang sudah ada": register → baris clients/environments (status
 * deklarasi, host kustom) + langganan + audit `tenant.register_existing` + rantai (kc_org_ensure → odoo_tenant_config)
 * dengan dispatcher PALSU; allowlist lama → baris data saja; penolakan atomik (slug ada, host dipakai, slug platform,
 * db_name di luar konvensi, ops); environment route manual: tombol job nonaktif dan layanan (job tunggal + rantai)
 * menolak `route_manual`; ulangi rantai pendaftaran. Postgres SEKALI PAKAI (TEST_DATABASE_URL; skema di-DROP).
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
import { auditLogs, clients, environments, plans, provisionJobs, subscriptions, users } from "@/db/schema";
import { enqueueChain } from "@/jobs/chain";
import { INFRA_JOB_QUEUE_OPTIONS, QUEUE_INFRA_JOB } from "@/jobs/queue";
import { enqueueBridgeJob, type Actor, type SendFn } from "@/jobs/service";
import { registerExistingTenant, registerOutcomeCode, retryChainFrom } from "@/jobs/tenants";
import { BRIDGE_JOB_TYPES, instanceJobTypes, type JobFile } from "@/lib/job-contract";
import { environmentJobAvailability, type RegisterExistingInput } from "@/lib/tenant-register";
import { createBridge, type Bridge } from "@/worker/bridge";
import { registerInfraJobWorker } from "@/worker/register";

const URL_ = process.env.TEST_DATABASE_URL;
const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
const META = { ip: "203.0.113.20", requestId: "req-register" };

type Res = { state: "succeeded" | "failed"; exit_code: number | null; error_code: string | null; result: Record<string, string> | null; tail: string[] };
type Behavior = (job: JobFile) => Res;
const ok = (result: Record<string, string>): Res => ({ state: "succeeded", exit_code: 0, error_code: null, result, tail: [] });
const fail = (): Res => ({ state: "failed", exit_code: 3, error_code: "script_exit", result: null, tail: ["ERROR: uji"] });

function uuidFrom(v: string): string {
  const x = createHash("sha256").update(v).digest("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-4${x.slice(13, 16)}-8${x.slice(17, 20)}-${x.slice(20, 32)}`;
}
const dbOf = (slug: string, env: string) => `${slug.replace(/-/g, "_")}_${env}`;

const defaultBehavior: Behavior = (j) => {
  const a = j.args as Record<string, unknown>;
  switch (j.type) {
    case "kc_org_ensure":
      return ok({ realm: "platform", org: uuidFrom(`org:${String(a.tenant_id)}`), created: "1", changed: "1" });
    case "odoo_tenant_config":
      return ok({ db: dbOf(j.slug, j.env), mode: String(a.tenant_check), changed: "1" });
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

describe.skipIf(!URL_)("Daftarkan tenant yang sudah ada ⇄ dispatcher palsu (Postgres nyata)", () => {
  let db: Db;
  let pool: { end: () => Promise<void> };
  let workerBoss: PgBoss;
  let webBoss: PgBoss;
  let send: SendFn;
  let root: string;
  let bridge: Bridge;
  let behave: Behavior = defaultBehavior;
  const seen: JobFile[] = [];
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
  const ageActorRate = () => db.execute(sql`UPDATE provision_jobs SET created_at = created_at - interval '2 minutes'`);
  const prodEnv = (slug: string, host: string, patch: Partial<RegisterExistingInput["envs"][number]> = {}): RegisterExistingInput["envs"][number] => ({
    kind: "prod",
    host,
    dbName: dbOf(slug, "prod"),
    dbStatus: "provisioned",
    routeStatus: "active",
    ssoStatus: "active",
    ...patch,
  });
  const form = (slug: string, patch: Partial<RegisterExistingInput> = {}): RegisterExistingInput => ({
    slug,
    name: `PT ${slug}`,
    brand: null,
    planId: null,
    envs: [prodEnv(slug, `erp.${slug}.id`)],
    ...patch,
  });
  const counts = async () => ({
    c: (await db.select().from(clients)).length,
    e: (await db.select().from(environments)).length,
    j: (await db.select().from(provisionJobs)).length,
    s: (await db.select().from(subscriptions)).length,
  });

  beforeAll(async () => {
    ({ db, pool } = createDb(URL_!, { max: 4, applicationName: "cp-int-register" }));
    await db.execute(sql`DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA IF EXISTS pgboss CASCADE; CREATE SCHEMA public;`);
    await migrate(db, { migrationsFolder: "./drizzle" });
    const platformId = (await ensurePlatformTenant(db)).id;
    await ensureInitialPlans(db);

    workerBoss = new PgBoss({ connectionString: URL_!, schema: "pgboss", max: 2 });
    workerBoss.on("error", () => undefined);
    await workerBoss.start();
    await workerBoss.createQueue(QUEUE_INFRA_JOB, INFRA_JOB_QUEUE_OPTIONS);
    webBoss = new PgBoss({ connectionString: URL_!, schema: "pgboss", max: 1, migrate: false, supervise: false, schedule: false });
    webBoss.on("error", () => undefined);
    await webBoss.start();
    send = (tx, id) => webBoss.send(QUEUE_INFRA_JOB, { provisionJobId: id }, { db: fromDrizzle(tx, sql), ...INFRA_JOB_QUEUE_OPTIONS });

    root = await mkdtemp(path.join(tmpdir(), "cp-int-register-"));
    for (const d of ["spool/tmp", "spool/new", "work", "results"]) await mkdir(path.join(root, d), { recursive: true });
    bridge = createBridge({ db, instance: "prod", spoolDir: path.join(root, "spool"), resultsDir: path.join(root, "results"), queueGraceSeconds: 900, logger: quiet });
    await registerInfraJobWorker(workerBoss, bridge, quiet, { pollingIntervalSeconds: 0.5 });

    const [sa] = await db.insert(users).values({ keycloakSub: "super-sub", role: "superadmin", clientId: platformId }).returning();
    const [op] = await db.insert(users).values({ keycloakSub: "ops-sub", role: "ops", clientId: platformId }).returning();
    SUPER = { sub: "super-sub", userId: sa!.id, roles: ["superadmin"] };
    OPS = { sub: "ops-sub", userId: op!.id, roles: ["ops"] };
  }, 60_000);

  afterAll(async () => {
    await workerBoss?.stop({ graceful: false, timeout: 2000 }).catch(() => undefined);
    await webBoss?.stop({ graceful: false, timeout: 2000 }).catch(() => undefined);
    await pool?.end();
    if (root) await rm(root, { recursive: true, force: true });
  });

  let expoId: string;
  let expoEnvId: string;

  it("expomedia (host kustom, SSO aktif, plan Odoo): baris deklarasi + langganan + audit + rantai kc_org_ensure → odoo_tenant_config", async () => {
    seen.length = 0;
    const planId = (await db.select().from(plans).where(eq(plans.code, "odoo-shared-s")))[0]!.id;
    const r = await registerExistingTenant(db, send, {
      ...svc(),
      form: form("expomedia", { name: "PT Expomedia", brand: "Expomedia", planId, envs: [prodEnv("expomedia", "erp.expomedia.id")] }),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(registerOutcomeCode(r)).toBe("queued");
    expoId = r.clientId;
    expect(r.jobIds).toHaveLength(2);

    const c = (await db.select().from(clients).where(eq(clients.id, expoId)))[0]!;
    expect(c).toMatchObject({ slug: "expomedia", name: "PT Expomedia", brand: "Expomedia", status: "active", isPlatform: false });
    const envRows = await db.select().from(environments).where(eq(environments.clientId, expoId));
    expect(envRows).toHaveLength(1);
    expoEnvId = envRows[0]!.id;
    expect(envRows[0]).toMatchObject({
      kind: "prod",
      odooInstance: "pool-a",
      dbName: "expomedia_prod",
      url: "https://erp.expomedia.id",
      host: "erp.expomedia.id",
      dbStatus: "provisioned",
      routeStatus: "active",
      ssoStatus: "active",
      tenantCheck: null,
    });
    const subs = await db.select().from(subscriptions).where(eq(subscriptions.clientId, expoId));
    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatchObject({ status: "implementation", planId });

    // Komposisi rantai: hanya kc_org_ensure + odoo_tenant_config(compat) — tanpa langkah DB/route/SSO.
    const jobs = ordered(await jobsOf(r.jobIds), r.jobIds);
    expect(jobs.map((j) => [j.type, j.env, j.payload])).toEqual([
      ["kc_org_ensure", "prod", { slug: "expomedia", args: { tenant_id: expoId } }],
      ["odoo_tenant_config", "prod", { slug: "expomedia", args: { tenant_check: "compat" } }],
    ]);
    expect(new Set(jobs.map((j) => j.chainId)).size).toBe(1);
    expect(jobs.every((j) => j.environmentId === null && j.clientId === expoId)).toBe(true);

    // SATU audit tenant.register_existing (sukses, chain_id) — tanpa PII.
    const aud = await db.select().from(auditLogs).where(and(eq(auditLogs.clientId, expoId), eq(auditLogs.action, "tenant.register_existing")));
    expect(aud).toHaveLength(1);
    expect(aud[0]).toMatchObject({ result: "success", actor: "user:super-sub", targetId: expoId });
    expect(aud[0]!.metadata).toMatchObject({
      slug: "expomedia",
      plan_id: planId,
      envs: ["prod"],
      environments: [{ kind: "prod", db_name: "expomedia_prod", host: "erp.expomedia.id", db: "provisioned", route: "active", sso: "active", route_manual: true }],
      chain_id: jobs[0]!.chainId,
      steps: ["kc_org_ensure@prod", "odoo_tenant_config@prod"],
    });
    expect(JSON.stringify(aud[0]!.metadata)).not.toContain("@expomedia");

    const done = ordered(await settleAll(r.jobIds), r.jobIds);
    expect(done.every((j) => j.status === "succeeded")).toBe(true);
    expect(seen.map((j) => `${j.type}@${j.env}`)).toEqual(["kc_org_ensure@prod", "odoo_tenant_config@prod"]);
    expect((await db.select().from(clients).where(eq(clients.id, expoId)))[0]!.kcOrgId).toBe(uuidFrom(`org:${expoId}`));
    const after = (await db.select().from(environments).where(eq(environments.id, expoEnvId)))[0]!;
    // Rekonsiliasi hanya tenant_check; status deklarasi + host kustom tetap.
    expect(after).toMatchObject({ tenantCheck: "compat", host: "erp.expomedia.id", dbStatus: "provisioned", routeStatus: "active", ssoStatus: "active" });
  });

  it("environment route manual: tombol DB/route/SSO nonaktif dan layanan menolak route_manual (diaudit), job lain tidak tersentuh", async () => {
    const env = (await db.select().from(environments).where(eq(environments.id, expoEnvId)))[0]!;
    expect(environmentJobAvailability(env)).toMatchObject({ manualRoute: true, dbProvision: false, route: false, sso: false, note: "Route manual — diadopsi di Fase 2" });

    const j0 = (await db.select().from(provisionJobs)).length;
    const tries = [
      { type: "odoo_route" as const, dryRun: false, args: { remove: false } },
      { type: "odoo_route" as const, dryRun: false, args: { remove: true } },
      { type: "odoo_route" as const, dryRun: false, args: { host: "erp.expomedia.id", remove: false } },
      { type: "odoo_db_provision" as const, dryRun: false, args: {} },
      { type: "odoo_sso_provision" as const, dryRun: false, args: { hosts: ["erp.expomedia.id"], rotate_secret: false, skip_smoke: false } },
      { type: "odoo_sso_provision" as const, dryRun: true, args: { hosts: ["expomedia.erp.bimacreative.tech"], rotate_secret: false, skip_smoke: true } },
      { type: "odoo_sso_disable" as const, dryRun: false, args: { hosts: ["erp.expomedia.id"] } },
    ];
    for (const t of tries) {
      const o = await enqueueBridgeJob(db, send, { instance: "prod", environmentId: expoEnvId, ...t, actor: SUPER, meta: META });
      expect(o, `${t.type} ${JSON.stringify(t.args)}`).toEqual({ ok: false, reason: "precondition", detail: "route_manual" });
    }
    expect((await db.select().from(provisionJobs)).length).toBe(j0);
    const rej = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.clientId, expoId), eq(auditLogs.result, "rejected"), sql`${auditLogs.metadata} ->> 'detail' = 'route_manual'`));
    expect(rej).toHaveLength(tries.length);

    // Rantai (mis. ulangan rantai onboarding): langkah route/SSO/DB untuk environment route manual ditolak utuh.
    for (const steps of [
      [{ type: "odoo_route" as const, env: "prod" as const, args: { remove: false } }],
      [
        { type: "odoo_tenant_config" as const, env: "prod" as const, args: { tenant_check: "compat" } },
        { type: "odoo_db_provision" as const, env: "prod" as const, args: {} },
      ],
    ]) {
      const out = await enqueueChain(db, send, {
        instance: "prod",
        allowedTypes: ALL,
        client: { id: expoId, slug: "expomedia" },
        steps,
        actor: SUPER,
        meta: META,
        audit: { action: "test.chain", targetType: "client", targetId: expoId, metadata: {} },
      });
      expect(out).toMatchObject({ ok: false, reason: "precondition", detail: "route_manual" });
    }
    expect((await db.select().from(provisionJobs)).length).toBe(j0);
  });

  it("environment host platform tetap bisa job route (tidak ikut terblokir)", async () => {
    await ageActorRate();
    const r = await registerExistingTenant(db, send, { ...svc(), form: form("plat-co", { envs: [prodEnv("plat-co", "plat-co.erp.bimacreative.tech", { ssoStatus: "none" })] }) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // SSO none → hanya kc_org_ensure.
    expect((await jobsOf(r.jobIds)).map((j) => j.type)).toEqual(["kc_org_ensure"]);
    await settleAll(r.jobIds);
    const env = (await db.select().from(environments).where(eq(environments.clientId, r.clientId)))[0]!;
    expect(environmentJobAvailability(env)).toMatchObject({ manualRoute: false, route: true, sso: true });
    const o = await enqueueBridgeJob(db, send, { instance: "prod", environmentId: env.id, type: "odoo_route", dryRun: false, args: { remove: false }, actor: SUPER, meta: META });
    expect(o.ok).toBe(true);
    if (o.ok) await settleAll([o.jobId]);
  });

  it("ditolak utuh: slug sudah ada / host dipakai / slug platform / db_name di luar konvensi / env bukan instance / ops", async () => {
    await ageActorRate();
    const c0 = await counts();
    expect(await registerExistingTenant(db, send, { ...svc(), form: form("expomedia", { envs: [prodEnv("expomedia", "erp2.expomedia.id")] }) })).toMatchObject({
      ok: false,
      reason: "exists",
    });
    expect(await registerExistingTenant(db, send, { ...svc(), form: form("other-co", { envs: [prodEnv("other-co", "erp.expomedia.id")] }) })).toMatchObject({
      ok: false,
      reason: "precondition",
      detail: "host_taken",
    });
    expect(await registerExistingTenant(db, send, { ...svc(), form: form("platform") })).toEqual({ ok: false, reason: "register", issue: "slug_reserved" });
    expect(
      await registerExistingTenant(db, send, { ...svc(), form: form("other-co", { envs: [prodEnv("other-co", "erp.other.id", { dbName: "other_co_production" })] }) }),
    ).toEqual({ ok: false, reason: "register", issue: "db_name_mismatch" });
    expect(await registerExistingTenant(db, send, { ...svc(), instance: "staging", form: form("other-co") })).toEqual({ ok: false, reason: "precondition", detail: "no_env" });
    expect(await registerExistingTenant(db, send, { ...svc(), actor: OPS, form: form("other-co") })).toEqual({ ok: false, reason: "forbidden" });
    // Rantai ditolak (kuota/plan) → baris tidak tersisa.
    expect(await registerExistingTenant(db, send, { ...svc(), form: form("other-co", { planId: "0b0b0b0b-0000-4000-8000-000000000000" }) })).toMatchObject({
      detail: "plan_inactive",
    });
    expect(await counts()).toEqual(c0);
    const rej = await db.select().from(auditLogs).where(and(eq(auditLogs.action, "tenant.register_existing"), eq(auditLogs.result, "rejected")));
    expect(rej.length).toBeGreaterThanOrEqual(7);
    expect(rej.every((a) => a.clientId === null)).toBe(true);
  });

  it("allowlist lama (tanpa kc_org_ensure/odoo_tenant_config) → baris data + audit saja, tanpa job; sebagian → registered_partial", async () => {
    await ageActorRate();
    const j0 = (await db.select().from(provisionJobs)).length;
    const r = await registerExistingTenant(db, send, { ...svc(), allowedTypes: instanceJobTypes(undefined), form: form("legacy-co") });
    expect(r).toMatchObject({ ok: true, chainId: null, jobIds: [], skipped: ["kc_org_ensure", "odoo_tenant_config"] });
    if (!r.ok) return;
    expect(registerOutcomeCode(r)).toBe("registered_no_jobs");
    expect((await db.select().from(provisionJobs)).length).toBe(j0);
    expect((await db.select().from(environments).where(eq(environments.clientId, r.clientId)))[0]).toMatchObject({ host: "erp.legacy-co.id", routeStatus: "active" });
    const aud = await db.select().from(auditLogs).where(and(eq(auditLogs.clientId, r.clientId), eq(auditLogs.action, "tenant.register_existing")));
    expect(aud).toHaveLength(1);
    expect(aud[0]!.metadata).toMatchObject({ steps: [], skipped_types: ["kc_org_ensure", "odoo_tenant_config"] });
    // Slug yang sama lagi (jalur tanpa rantai) → exists, tanpa baris tambahan.
    expect(await registerExistingTenant(db, send, { ...svc(), allowedTypes: instanceJobTypes(undefined), form: form("legacy-co", { envs: [prodEnv("legacy-co", "erp2.legacy-co.id")] }) })).toEqual({
      ok: false,
      reason: "exists",
    });

    const p = await registerExistingTenant(db, send, { ...svc(), allowedTypes: instanceJobTypes("kc_org_ensure"), form: form("part-co") });
    expect(p.ok && registerOutcomeCode(p)).toBe("registered_partial");
    if (p.ok) {
      expect((await jobsOf(p.jobIds)).map((j) => j.type)).toEqual(["kc_org_ensure"]);
      await settleAll(p.jobIds);
    }
  });

  it("rantai pendaftaran yang gagal bisa diulang dari langkah gagal (origin tenant.register_existing)", async () => {
    await ageActorRate();
    behave = (j) => (j.type === "odoo_tenant_config" ? fail() : defaultBehavior(j));
    const r = await registerExistingTenant(db, send, { ...svc(), form: form("retry-co") });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const rows = ordered(await settleAll(r.jobIds), r.jobIds);
    expect(rows.map((x) => x.status)).toEqual(["succeeded", "failed"]);
    behave = defaultBehavior;
    const again = await retryChainFrom(db, send, { ...svc(), jobId: rows[1]!.id });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    const re = await settleAll(again.jobIds);
    expect(re.map((x) => [x.type, x.status, x.parentJobId])).toEqual([["odoo_tenant_config", "succeeded", rows[1]!.id]]);
  });
});
