/**
 * Integrasi: Postgres nyata (TEST_DATABASE_URL, container sekali pakai) + pg-boss + worker bridge +
 * dispatcher PALSU di direktori temp (meniru kontrak plan 05 §3.2/§4.5: rename new/→work/, tulis
 * results/<id>.json running → final secara atomik). Tidak menyentuh host, Docker, atau skrip nyata.
 * Jalankan: npm run test:integration (lihat README §Test integrasi).
 */
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { PgBoss, fromDrizzle } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db } from "@/db/client";
import { auditLogs, clients, environments, provisionJobs, tenantUserAccess } from "@/db/schema";
import { INFRA_JOB_QUEUE_OPTIONS, QUEUE_INFRA_JOB } from "@/jobs/queue";
import { enqueueBridgeJob, retryBridgeJob, type Actor, type SendFn } from "@/jobs/service";
import type { JobFile } from "@/lib/job-contract";
import { createBridge, type Bridge } from "@/worker/bridge";
import { registerInfraJobWorker } from "@/worker/register";

const URL_ = process.env.TEST_DATABASE_URL;
const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };

type Behavior = (job: JobFile) => { state: "succeeded" | "failed"; exit_code: number | null; error_code: string | null; result: Record<string, string | undefined> | null; tail: string[] } | "hang";

async function atomicWrite(dir: string, name: string, body: unknown) {
  const tmp = path.join(dir, `.${name}.tmp`);
  await writeFile(tmp, JSON.stringify(body));
  await rename(tmp, path.join(dir, name));
}

/** Dispatcher palsu: satu putaran memproses semua file di new/ (serial, seperti dispatcher nyata). */
async function fakeDispatchOnce(root: string, behave: Behavior): Promise<JobFile[]> {
  const newDir = path.join(root, "spool", "new");
  const work = path.join(root, "work");
  const results = path.join(root, "results");
  const done: JobFile[] = [];
  for (const name of await readdir(newDir)) {
    await rename(path.join(newDir, name), path.join(work, name));
    const job = JSON.parse(await readFile(path.join(work, name), "utf8")) as JobFile;
    done.push(job);
    const b = behave(job);
    const started = new Date().toISOString();
    await atomicWrite(results, name, { v: 1, job_id: job.job_id, state: "running", started_at: started });
    if (b === "hang") continue;
    await atomicWrite(results, name, {
      v: 1,
      job_id: job.job_id,
      ...b,
      started_at: started,
      finished_at: new Date().toISOString(),
      duration_ms: 5,
    });
  }
  return done;
}

async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, ms = 15_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 100));
  }
}

const OPS: Actor = { sub: "ops-sub", userId: null, roles: ["ops"] };
const SUPER: Actor = { sub: "super-sub", userId: null, roles: ["superadmin"] };
const META = { ip: "203.0.113.5", requestId: "req-1" };

describe.skipIf(!URL_)("bridge worker ⇄ dispatcher palsu (Postgres nyata)", () => {
  let db: Db;
  let pool: { end: () => Promise<void> };
  let workerBoss: PgBoss;
  let webBoss: PgBoss;
  let send: SendFn;
  let root: string;
  let bridge: Bridge;
  let clock = () => new Date();
  let envProd: string;
  let envStaging: string;
  let behave: Behavior = () => ({ state: "succeeded", exit_code: 0, error_code: null, result: { changed: "0" }, tail: [] });

  const job = async (id: string) => (await db.select().from(provisionJobs).where(eq(provisionJobs.id, id)))[0]!;
  const settle = async (id: string, statuses = ["succeeded", "failed"]) =>
    waitFor(async () => {
      await fakeDispatchOnce(root, behave);
      await bridge.tick();
      const j = await job(id);
      return statuses.includes(j.status) ? j : null;
    });

  beforeAll(async () => {
    ({ db, pool } = createDb(URL_!, { max: 4, applicationName: "cp-int-test" }));
    await db.execute(sql`DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA IF EXISTS pgboss CASCADE; CREATE SCHEMA public;`);
    await migrate(db, { migrationsFolder: "./drizzle" });

    workerBoss = new PgBoss({ connectionString: URL_!, schema: "pgboss", max: 2 });
    workerBoss.on("error", () => undefined);
    await workerBoss.start();
    await workerBoss.createQueue(QUEUE_INFRA_JOB, INFRA_JOB_QUEUE_OPTIONS);

    // Klien web: tanpa migrasi/supervisor/cron (sama dengan src/server/boss.ts).
    webBoss = new PgBoss({ connectionString: URL_!, schema: "pgboss", max: 1, migrate: false, supervise: false, schedule: false });
    webBoss.on("error", () => undefined);
    await webBoss.start();
    send = (tx, id) => webBoss.send(QUEUE_INFRA_JOB, { provisionJobId: id }, { db: fromDrizzle(tx, sql), ...INFRA_JOB_QUEUE_OPTIONS });

    root = await mkdtemp(path.join(tmpdir(), "cp-int-"));
    for (const d of ["spool/tmp", "spool/new", "work", "results"]) await mkdir(path.join(root, d), { recursive: true });
    bridge = createBridge({
      db,
      instance: "prod",
      spoolDir: path.join(root, "spool"),
      resultsDir: path.join(root, "results"),
      queueGraceSeconds: 900,
      logger: quiet,
      now: () => clock(),
    });
    await registerInfraJobWorker(workerBoss, bridge, quiet, { pollingIntervalSeconds: 0.5 });

    const [c] = await db.insert(clients).values({ slug: "acme-co", name: "Acme" }).returning();
    const [e] = await db
      .insert(environments)
      .values({ clientId: c!.id, kind: "prod", odooInstance: "pool-a", dbName: "acme_co_prod", url: "https://acme-co.erp.bimacreative.tech" })
      .returning();
    const [s] = await db
      .insert(environments)
      .values({ clientId: c!.id, kind: "staging", odooInstance: "staging", dbName: "acme_co_staging", url: "https://acme-co.staging.bimacreative.tech" })
      .returning();
    envProd = e!.id;
    envStaging = s!.id;
  }, 60_000);

  afterAll(async () => {
    await workerBoss?.stop({ graceful: false, timeout: 2000 }).catch(() => undefined);
    await webBoss?.stop({ graceful: false, timeout: 2000 }).catch(() => undefined);
    await pool?.end();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("alur penuh: DB → route → SSO; status & kolom environment dari RESULT; secret tidak masuk CP; audit", async () => {
    behave = (j) => {
      if (j.type === "odoo_db_provision")
        return { state: "succeeded", exit_code: 0, error_code: null, result: { db: "acme_co_prod", pool: "pool-a", created: "yes", changed: "4", secret: "/opt/infra/odoo/pool-a/secrets/tenants/acme_co_prod.admin-password" }, tail: ["ok"] };
      if (j.type === "odoo_route")
        return { state: "succeeded", exit_code: 0, error_code: null, result: { route: "/opt/infra/traefik/dynamic/clients/acme-co-prod.yml", host: "acme-co.erp.bimacreative.tech", db: "acme_co_prod", changed: "yes" }, tail: [] };
      return {
        state: "succeeded",
        exit_code: 0,
        error_code: null,
        result: { db: "acme_co_prod", realm: "platform", client: "odoo-acme-co-prod", provider: "7", hosts: "acme-co.erp.bimacreative.tech", changed: "3", secret_file: "/opt/infra/odoo/pool-a/secrets/oidc/acme_co_prod" },
        tail: ["[acme_co_prod] install", "client secret=SUPERSECRETVALUE", "RESULT …"],
      };
    };

    const r1 = await enqueueBridgeJob(db, send, { instance: "prod", environmentId: envProd, type: "odoo_db_provision", dryRun: false, args: {}, actor: OPS, meta: META });
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    // pesan pg-boss dibuat di transaksi yang sama → worker menulis spool → status dispatched/running/succeeded
    await waitFor(async () => (await job(r1.jobId)).status !== "queued");
    const spoolFile = await waitFor(async () => {
      const names = await readdir(path.join(root, "spool", "new"));
      return names.length ? names : null;
    });
    expect(spoolFile).toEqual([`${r1.jobId}.json`]);
    const content = JSON.parse(await readFile(path.join(root, "spool", "new", `${r1.jobId}.json`), "utf8"));
    expect(content).toMatchObject({ v: 1, job_id: r1.jobId, type: "odoo_db_provision", slug: "acme-co", env: "prod", dry_run: false, actor: "user:ops-sub", args: {} });
    const j1 = await settle(r1.jobId);
    expect(j1.status).toBe("succeeded");
    expect(j1.result).toEqual({ db: "acme_co_prod", pool: "pool-a", created: "yes", changed: "4" });
    expect(j1.bossJobId).toBeTruthy();

    const r2 = await enqueueBridgeJob(db, send, { instance: "prod", environmentId: envProd, type: "odoo_route", dryRun: false, args: { remove: false }, actor: OPS, meta: META });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    await waitFor(async () => (await job(r2.jobId)).status !== "queued");
    expect((await settle(r2.jobId)).status).toBe("succeeded");

    const r3 = await enqueueBridgeJob(db, send, {
      instance: "prod",
      environmentId: envProd,
      type: "odoo_sso_provision",
      dryRun: false,
      args: { hosts: ["acme-co.erp.bimacreative.tech"], rotate_secret: false, skip_smoke: false },
      actor: OPS,
      meta: META,
    });
    expect(r3.ok).toBe(true);
    if (!r3.ok) return;
    await waitFor(async () => (await job(r3.jobId)).status !== "queued");
    const j3 = await settle(r3.jobId);
    expect(j3.status).toBe("succeeded");
    expect(j3.result).not.toHaveProperty("secret_file");
    expect(j3.log).not.toContain("SUPERSECRETVALUE");
    expect(j3.log).toContain("[redacted]");

    const [env] = await db.select().from(environments).where(eq(environments.id, envProd));
    expect(env).toMatchObject({
      dbStatus: "provisioned",
      routeStatus: "active",
      host: "acme-co.erp.bimacreative.tech",
      ssoStatus: "active",
      ssoClientId: "odoo-acme-co-prod",
      ssoProviderId: 7,
      lastJobId: r3.jobId,
    });

    const audits = await db.select().from(auditLogs).where(eq(auditLogs.targetId, envProd));
    const actions = audits.map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["job.enqueue.odoo_db_provision", "job.enqueue.odoo_route", "job.enqueue.odoo_sso_provision", "job.finish"]));
    expect(actions.filter((a) => a === "job.finish").length).toBe(3);
    expect(audits.find((a) => a.action === "job.enqueue.odoo_db_provision")).toMatchObject({ ip: "203.0.113.5", requestId: "req-1", actor: "user:ops-sub" });
    // Tidak ada secret di tabel CP mana pun.
    const dump = JSON.stringify(await db.execute(sql`SELECT row_to_json(p) FROM provision_jobs p`));
    expect(dump).not.toContain("SUPERSECRETVALUE");
    expect(dump).not.toContain("secrets/oidc");
    expect(dump).not.toContain("admin-password");
  });

  it("AC-J11: dua enqueue paralel environment+type sama → satu dibuat, satu duplicate", async () => {
    behave = () => "hang";
    const mk = () =>
      enqueueBridgeJob(db, send, { instance: "prod", environmentId: envProd, type: "odoo_route", dryRun: false, args: { remove: false }, actor: SUPER, meta: META });
    const [a, b] = await Promise.all([mk(), mk()]);
    const oks = [a, b].filter((x) => x.ok);
    expect(oks.length).toBe(1);
    expect([a, b].find((x) => !x.ok)).toMatchObject({ ok: false, reason: "duplicate" });
    const active = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(provisionJobs)
      .where(and(eq(provisionJobs.environmentId, envProd), eq(provisionJobs.type, "odoo_route"), sql`${provisionJobs.status} NOT IN ('succeeded','failed','cancelled')`));
    expect(active[0]!.n).toBe(1);

    // Tidak ada hasil final (dispatcher "hang") → watchdog no_result setelah deadline.
    const id = (oks[0] as { jobId: string }).jobId;
    await waitFor(async () => {
      await fakeDispatchOnce(root, behave);
      await bridge.tick();
      return (await job(id)).status === "running";
    });
    clock = () => new Date(Date.now() + 3 * 3600_000);
    await bridge.watchdog();
    clock = () => new Date();
    expect(await job(id)).toMatchObject({ status: "failed", errorCode: "no_result" });

    // "Ulangi" → job baru dengan parent_job_id
    const retry = await retryBridgeJob(db, send, { instance: "prod", jobId: id, actor: OPS, meta: META });
    expect(retry.ok).toBe(true);
    if (retry.ok) {
      expect((await job(retry.jobId)).parentJobId).toBe(id);
      behave = () => ({ state: "succeeded", exit_code: 0, error_code: null, result: { host: "acme-co.erp.bimacreative.tech", changed: "no" }, tail: [] });
      await waitFor(async () => (await job(retry.jobId)).status !== "queued");
      expect((await settle(retry.jobId)).status).toBe("succeeded");
    }
  });

  it("odoo_sso_user: grant → pending → active (kc_user/odoo_user); grant gagal blocked_dry_run → failed", async () => {
    behave = (j) =>
      j.args.email === "good@b.co"
        ? { state: "succeeded", exit_code: 0, error_code: null, result: { kc_user: "33333333-3333-4333-8333-333333333333", odoo_user: "12", action: "grant", changed: "2" }, tail: [] }
        : { state: "failed", exit_code: 1, error_code: "blocked_dry_run", result: { blockers: "1", mode: "dry-run" }, tail: ["login belum ada"] };
    const r = await enqueueBridgeJob(db, send, {
      instance: "prod",
      environmentId: envProd,
      type: "odoo_sso_user",
      dryRun: false,
      args: { action: "grant", email: "good@b.co", admin: false, create_kc: true },
      actor: OPS,
      meta: META,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const [pending] = await db.select().from(tenantUserAccess).where(eq(tenantUserAccess.email, "good@b.co"));
    expect(pending).toMatchObject({ status: "pending", lastJobId: r.jobId });
    await waitFor(async () => (await job(r.jobId)).status !== "queued");
    await settle(r.jobId);
    const [active] = await db.select().from(tenantUserAccess).where(eq(tenantUserAccess.email, "good@b.co"));
    expect(active).toMatchObject({ status: "active", kcUserId: "33333333-3333-4333-8333-333333333333", odooUserId: 12 });
    // audit tanpa email mentah
    const enq = await db.select().from(auditLogs).where(eq(auditLogs.action, "job.enqueue.odoo_sso_user"));
    expect(JSON.stringify(enq.map((a) => a.metadata))).not.toContain("good@b.co");
    expect(enq[0]!.metadata).toHaveProperty("email_hash");

    const bad = await enqueueBridgeJob(db, send, {
      instance: "prod",
      environmentId: envProd,
      type: "odoo_sso_user",
      dryRun: false,
      args: { action: "grant", email: "nologin@b.co", admin: false, create_kc: true },
      actor: OPS,
      meta: META,
    });
    expect(bad.ok).toBe(true);
    if (!bad.ok) return;
    await waitFor(async () => (await job(bad.jobId)).status !== "queued");
    expect(await settle(bad.jobId)).toMatchObject({ status: "failed", errorCode: "blocked_dry_run", exitCode: 1 });
    const [failed] = await db.select().from(tenantUserAccess).where(eq(tenantUserAccess.email, "nologin@b.co"));
    expect(failed!.status).toBe("failed");

    // revoke untuk email yang tidak terdaftar → precondition, tanpa baris job
    const rv = await enqueueBridgeJob(db, send, {
      instance: "prod",
      environmentId: envProd,
      type: "odoo_sso_user",
      dryRun: false,
      args: { action: "revoke", email: "unknown@b.co", admin: false, create_kc: false },
      actor: OPS,
      meta: META,
    });
    expect(rv).toMatchObject({ ok: false, reason: "precondition", detail: "user_not_listed" });
  });

  it("AC-J12/otorisasi: client_admin & ops (aksi admin) ditolak tanpa baris job; env lintas instance ditolak", async () => {
    const before = (await db.select({ n: sql<number>`count(*)::int` }).from(provisionJobs))[0]!.n;
    const ca = await enqueueBridgeJob(db, send, { instance: "prod", environmentId: envProd, type: "odoo_db_provision", dryRun: false, args: {}, actor: { sub: "ca", userId: null, roles: ["client_admin"] }, meta: META });
    expect(ca).toMatchObject({ ok: false, reason: "forbidden" });
    const rot = await enqueueBridgeJob(db, send, {
      instance: "prod",
      environmentId: envProd,
      type: "odoo_sso_provision",
      dryRun: false,
      args: { hosts: ["acme-co.erp.bimacreative.tech"], rotate_secret: true, skip_smoke: false },
      actor: OPS,
      meta: META,
    });
    expect(rot).toMatchObject({ ok: false, reason: "forbidden" });
    const dis = await enqueueBridgeJob(db, send, { instance: "prod", environmentId: envProd, type: "odoo_sso_disable", dryRun: false, args: { hosts: ["acme-co.erp.bimacreative.tech"] }, actor: OPS, meta: META });
    expect(dis).toMatchObject({ ok: false, reason: "forbidden" });
    const cross = await enqueueBridgeJob(db, send, { instance: "prod", environmentId: envStaging, type: "odoo_db_provision", dryRun: false, args: {}, actor: SUPER, meta: META });
    expect(cross).toMatchObject({ ok: false, reason: "invalid", issue: "env_instance" });
    const foreign = await enqueueBridgeJob(db, send, { instance: "prod", environmentId: envProd, type: "odoo_sso_provision", dryRun: false, args: { hosts: ["other.erp.bimacreative.tech"], rotate_secret: false, skip_smoke: false }, actor: SUPER, meta: META });
    expect(foreign).toMatchObject({ ok: false, reason: "precondition", detail: "host_not_in_route" });
    expect((await db.select({ n: sql<number>`count(*)::int` }).from(provisionJobs))[0]!.n).toBe(before);
    const rejected = await db.select().from(auditLogs).where(eq(auditLogs.result, "rejected"));
    expect(rejected.length).toBeGreaterThanOrEqual(5);
  });

  it("kuota: odoo_db_provision 3/hari → ke-4 ditolak rejected quota", async () => {
    // 1 sudah dibuat di tes pertama; tambah 2 baris final agar hitungan = 3.
    for (let i = 0; i < 2; i++) {
      await db.insert(provisionJobs).values({ type: "odoo_db_provision", status: "succeeded", environmentId: envProd, env: "prod", actor: "user:x", payload: {} });
    }
    const q = await enqueueBridgeJob(db, send, { instance: "prod", environmentId: envProd, type: "odoo_db_provision", dryRun: false, args: {}, actor: SUPER, meta: META });
    expect(q).toMatchObject({ ok: false, reason: "quota", violation: "db_provision_day" });
  });

  it("spool tidak bisa ditulis → failed error_code spool_error (CHECK DB menerima kode baru)", async () => {
    const broken = createBridge({
      db,
      instance: "prod",
      spoolDir: path.join(root, "does-not-exist"),
      resultsDir: path.join(root, "results"),
      queueGraceSeconds: 900,
      logger: quiet,
    });
    const [row] = await db
      .insert(provisionJobs)
      .values({ type: "odoo_sso_disable", status: "queued", environmentId: envProd, env: "prod", actor: "user:x", payload: { slug: "acme-co", args: { hosts: ["acme-co.erp.bimacreative.tech"] } } })
      .returning();
    expect(await broken.dispatch(row!.id)).toBe("spool_failed");
    expect(await job(row!.id)).toMatchObject({ status: "failed", errorCode: "spool_error", error: "spool: ENOENT" });
  });

  it("baris DB dimanipulasi (args ekstra) → worker menolak rejected_validation, tidak ada file spool", async () => {
    const [row] = await db
      .insert(provisionJobs)
      .values({ type: "odoo_sso_disable", status: "queued", environmentId: envProd, env: "prod", actor: "user:x", payload: { slug: "acme-co", args: { hosts: ["acme-co.erp.bimacreative.tech"], cmd: "id" } } })
      .returning();
    expect(await bridge.dispatch(row!.id)).toBe("rejected");
    expect(await job(row!.id)).toMatchObject({ status: "failed", errorCode: "rejected_validation" });
    expect(await readdir(path.join(root, "spool", "new"))).not.toContain(`${row!.id}.json`);
    // env lintas instance di baris DB
    const [row2] = await db
      .insert(provisionJobs)
      .values({ type: "odoo_db_provision", status: "queued", environmentId: envStaging, env: "staging", actor: "user:x", payload: { slug: "acme-co", args: {} } })
      .returning();
    expect(await bridge.dispatch(row2!.id)).toBe("rejected");
  });
});
