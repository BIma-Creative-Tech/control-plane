/**
 * Integrasi SaaS Fase 1 (kontrak §2): migrasi 0000..0004 di DB kosong + tenant `platform`, rantai job user dengan
 * dispatcher PALSU (direktori temp), idempotency, chain_aborted, rekonsiliasi users dari RESULT kc_user, dan
 * otorisasi lintas tenant di lapisan layanan. Postgres SEKALI PAKAI (TEST_DATABASE_URL; skema di-DROP).
 */
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { and, eq, inArray, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { PgBoss, fromDrizzle } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db } from "@/db/client";
import { ensurePlatformTenant } from "@/db/platform";
import { auditLogs, clients, environments, provisionJobs, tenantUserAccess, users } from "@/db/schema";
import { upsertUserOnLogin } from "@/db/users";
import { INFRA_JOB_QUEUE_OPTIONS, QUEUE_INFRA_JOB } from "@/jobs/queue";
import type { Actor, SendFn } from "@/jobs/service";
import { addUser, changeUserAccess, sendPasswordReset, setUserEnabled } from "@/jobs/users";
import { BRIDGE_JOB_TYPES, type JobFile } from "@/lib/job-contract";
import { createBridge, type Bridge } from "@/worker/bridge";
import { registerInfraJobWorker } from "@/worker/register";

const URL_ = process.env.TEST_DATABASE_URL;
const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
const META = { ip: "203.0.113.9", requestId: "req-users" };
const KC_BUDI = "9a1b2c3d-1111-4222-8333-444455556666";
const ORG_ACME = "0f0e0d0c-1111-4222-8333-444455556666";

type Res = { state: "succeeded" | "failed"; exit_code: number | null; error_code: string | null; result: Record<string, string> | null; tail: string[] };
type Behavior = (job: JobFile) => Res;

const ok = (result: Record<string, string>): Res => ({ state: "succeeded", exit_code: 0, error_code: null, result, tail: [] });

const defaultBehavior: Behavior = (j) => {
  const email = String((j.args as Record<string, unknown>).email ?? "");
  const kc = email === "budi@acme.co.id" ? KC_BUDI : "5b5b5b5b-1111-4222-8333-444455556666";
  switch (j.type) {
    case "kc_org_ensure":
      return ok({ realm: "platform", org: ORG_ACME, created: "yes", changed: "1" });
    case "kc_user_ensure":
      return ok({ realm: "platform", kc_user: kc, created: "yes", changed: "1", invite: "sent" });
    case "kc_user_set_roles":
      return ok({ kc_user: kc, roles: "client_user,odoo_access", changed: "1" });
    case "kc_user_set_enabled":
      return ok({ kc_user: kc, enabled: String((j.args as Record<string, unknown>).enabled), changed: "1" });
    case "kc_user_action_email":
      return ok({ kc_user: kc, action: "UPDATE_PASSWORD", invite: "sent" });
    case "odoo_user_ensure":
      return ok({ db: `acme_co_${j.env}`, odoo_user: "9", kc_user: kc, created: "yes", changed: "1" });
    default:
      return ok({ changed: "0" });
  }
};

async function atomicWrite(dir: string, name: string, body: unknown) {
  const tmp = path.join(dir, `.${name}.tmp`);
  await writeFile(tmp, JSON.stringify(body));
  await rename(tmp, path.join(dir, name));
}

async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, ms = 20_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe.skipIf(!URL_)("Users: rantai job ⇄ dispatcher palsu (Postgres nyata)", () => {
  let db: Db;
  let pool: { end: () => Promise<void> };
  let workerBoss: PgBoss;
  let webBoss: PgBoss;
  let send: SendFn;
  let root: string;
  let bridge: Bridge;
  let behave: Behavior = defaultBehavior;
  /** Urutan file job yang dilihat dispatcher palsu (bukti rantai berurutan). */
  const seen: JobFile[] = [];
  let platformId: string;
  let acmeId: string;
  let betaId: string;
  let envAcmeProd: string;
  let envAcmeDemo: string;
  let SUPER: Actor;
  let CADMIN: Actor;
  const ALL = [...BRIDGE_JOB_TYPES];

  async function fakeDispatchOnce() {
    const newDir = path.join(root, "spool", "new");
    for (const name of (await readdir(newDir)).sort()) {
      await rename(path.join(newDir, name), path.join(root, "work", name));
      const job = JSON.parse(await readFile(path.join(root, "work", name), "utf8")) as JobFile;
      seen.push(job);
      const b = behave(job);
      const started = new Date().toISOString();
      await atomicWrite(path.join(root, "results"), name, { v: 1, job_id: job.job_id, ...b, started_at: started, finished_at: new Date().toISOString(), duration_ms: 3 });
    }
  }
  const jobsOf = async (ids: string[]) =>
    db.select().from(provisionJobs).where(inArray(provisionJobs.id, ids));
  const settleAll = async (ids: string[]) =>
    waitFor(async () => {
      await fakeDispatchOnce();
      await bridge.tick();
      const rows = await jobsOf(ids);
      return rows.every((r) => ["succeeded", "failed", "cancelled"].includes(r.status)) ? rows : null;
    });

  beforeAll(async () => {
    ({ db, pool } = createDb(URL_!, { max: 4, applicationName: "cp-int-users" }));
    await db.execute(sql`DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA IF EXISTS pgboss CASCADE; CREATE SCHEMA public;`);
    // 0000..0004 pada DB kosong (drizzle-orm migrator, sama dengan dist/db/migrate.mjs) + langkah boot platform.
    await migrate(db, { migrationsFolder: "./drizzle" });
    const p1 = await ensurePlatformTenant(db);
    const p2 = await ensurePlatformTenant(db);
    expect(p1.created).toBe(true);
    expect(p2).toEqual({ id: p1.id, created: false });
    platformId = p1.id;

    workerBoss = new PgBoss({ connectionString: URL_!, schema: "pgboss", max: 2 });
    workerBoss.on("error", () => undefined);
    await workerBoss.start();
    await workerBoss.createQueue(QUEUE_INFRA_JOB, INFRA_JOB_QUEUE_OPTIONS);
    webBoss = new PgBoss({ connectionString: URL_!, schema: "pgboss", max: 1, migrate: false, supervise: false, schedule: false });
    webBoss.on("error", () => undefined);
    await webBoss.start();
    send = (tx, id) => webBoss.send(QUEUE_INFRA_JOB, { provisionJobId: id }, { db: fromDrizzle(tx, sql), ...INFRA_JOB_QUEUE_OPTIONS });

    root = await mkdtemp(path.join(tmpdir(), "cp-int-users-"));
    for (const d of ["spool/tmp", "spool/new", "work", "results"]) await mkdir(path.join(root, d), { recursive: true });
    bridge = createBridge({
      db,
      instance: "prod",
      spoolDir: path.join(root, "spool"),
      resultsDir: path.join(root, "results"),
      queueGraceSeconds: 900,
      logger: quiet,
    });
    await registerInfraJobWorker(workerBoss, bridge, quiet, { pollingIntervalSeconds: 0.5 });

    const [a] = await db.insert(clients).values({ slug: "acme-co", name: "Acme" }).returning();
    const [b] = await db.insert(clients).values({ slug: "beta-co", name: "Beta" }).returning();
    acmeId = a!.id;
    betaId = b!.id;
    const [ep] = await db
      .insert(environments)
      .values({ clientId: acmeId, kind: "prod", odooInstance: "pool-a", dbName: "acme_co_prod", url: "https://acme-co.erp.bimacreative.tech" })
      .returning();
    const [ed] = await db
      .insert(environments)
      .values({ clientId: acmeId, kind: "demo", odooInstance: "pool-a", dbName: "acme_co_demo", url: "https://acme-demo.erp.bimacreative.tech" })
      .returning();
    envAcmeProd = ep!.id;
    envAcmeDemo = ed!.id;

    const [sa] = await db.insert(users).values({ keycloakSub: "super-sub", role: "superadmin", clientId: platformId }).returning();
    const [ca] = await db.insert(users).values({ keycloakSub: "cadmin-sub", role: "client_admin", clientId: acmeId }).returning();
    await db.insert(users).values({ keycloakSub: "beta-user-sub", email: "rina@beta.co.id", role: "client_user", clientId: betaId });
    SUPER = { sub: "super-sub", userId: sa!.id, roles: ["superadmin"] };
    CADMIN = { sub: "cadmin-sub", userId: ca!.id, roles: ["client_admin"] };
  }, 60_000);

  afterAll(async () => {
    await workerBoss?.stop({ graceful: false, timeout: 2000 }).catch(() => undefined);
    await webBoss?.stop({ graceful: false, timeout: 2000 }).catch(() => undefined);
    await pool?.end();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("skema 0004: kolom/indeks/CHECK baru ada; platform tepat satu", async () => {
    const cols = await db.execute<{ table_name: string; column_name: string }>(sql`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema='public' AND (table_name, column_name) IN (
        ('clients','status'),('clients','isolation'),('clients','brand'),('clients','kc_org_id'),('clients','is_platform'),
        ('users','status'),('users','invited_by'),('users','disabled_at'),
        ('provision_jobs','idempotency_key'),('provision_jobs','after_job_id'),('provision_jobs','chain_id'))`);
    expect(cols.rows).toHaveLength(11);
    await expect(db.insert(clients).values({ slug: "platform-2", name: "x", isPlatform: true })).rejects.toThrow();
    await expect(
      db.insert(provisionJobs).values({ type: "kc_user_ensure", actor: "system:t", errorCode: "bogus" }),
    ).rejects.toThrow();
    const [j] = await db.insert(provisionJobs).values({ type: "kc_user_ensure", actor: "system:t", status: "cancelled", errorCode: "chain_aborted" }).returning();
    expect(j!.errorCode).toBe("chain_aborted");
    await db.delete(provisionJobs).where(eq(provisionJobs.id, j!.id));
  });

  it("tambah user (superadmin): kc_org_ensure → kc_user_ensure → kc_user_set_roles → odoo_user_ensure, berurutan; users dari RESULT", async () => {
    seen.length = 0;
    const r = await addUser(db, send, {
      instance: "prod",
      allowedTypes: ALL,
      actor: SUPER,
      meta: META,
      clientId: acmeId,
      email: "Budi@Acme.co.id",
      name: "Budi Santoso",
      cpRole: "client_user",
      odoo: { [envAcmeProd]: "user", [envAcmeDemo]: "none" },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.jobIds).toHaveLength(4);
    const rows = await settleAll(r.jobIds);
    expect(rows.every((x) => x.status === "succeeded")).toBe(true);
    // Dispatcher hanya pernah melihat langkah berikutnya SETELAH langkah sebelumnya selesai (urutan rantai).
    expect(seen.map((j) => j.type)).toEqual(["kc_org_ensure", "kc_user_ensure", "kc_user_set_roles", "odoo_user_ensure"]);
    expect(seen.every((j) => j.slug === "acme-co" && j.actor === "user:super-sub")).toBe(true);
    expect(new Set(rows.map((x) => x.chainId)).size).toBe(1);
    expect(rows.find((x) => x.type === "kc_user_ensure")!.idempotencyKey).toBe("kc_user_ensure:acme-co:prod:budi@acme.co.id");

    const client = (await db.select().from(clients).where(eq(clients.id, acmeId)))[0]!;
    expect(client.kcOrgId).toBe(ORG_ACME);
    const u = (await db.select().from(users).where(eq(users.keycloakSub, KC_BUDI)))[0]!;
    expect(u).toMatchObject({ email: "budi@acme.co.id", clientId: acmeId, status: "invited", role: "client_user", invitedBy: SUPER.userId, displayName: "Budi Santoso" });
    const tua = await db.select().from(tenantUserAccess).where(eq(tenantUserAccess.email, "budi@acme.co.id"));
    expect(tua).toHaveLength(1);
    expect(tua[0]).toMatchObject({ environmentId: envAcmeProd, status: "active", isTenantAdmin: false, odooUserId: 9, kcUserId: KC_BUDI });
    // audit: aksi user (tanpa email mentah) + job.finish per langkah
    const audit = await db.select().from(auditLogs).where(eq(auditLogs.action, "user.add"));
    expect(audit).toHaveLength(1);
    expect(audit[0]!.actorUserId).toBe(SUPER.userId);
    expect(JSON.stringify(audit[0]!.metadata)).not.toContain("budi@");

    // Login pertama → invited → active; client_id tidak disentuh login.
    await upsertUserOnLogin(db, { sub: KC_BUDI, email: "budi@acme.co.id", name: "Budi", roles: ["client_user"] });
    const u2 = (await db.select().from(users).where(eq(users.keycloakSub, KC_BUDI)))[0]!;
    expect(u2.status).toBe("active");
    expect(u2.clientId).toBe(acmeId);
  });

  it("idempotency: permintaan ganda saat job masih aktif → job yang sama dipakai ulang", async () => {
    const u = (await db.select().from(users).where(eq(users.keycloakSub, KC_BUDI)))[0]!;
    const a = await sendPasswordReset(db, send, { instance: "prod", allowedTypes: ALL, actor: SUPER, meta: META, userId: u.id });
    const b = await sendPasswordReset(db, send, { instance: "prod", allowedTypes: ALL, actor: SUPER, meta: META, userId: u.id });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(b.jobIds).toEqual(a.jobIds);
    const n = await db.select().from(provisionJobs).where(eq(provisionJobs.type, "kc_user_action_email"));
    expect(n).toHaveLength(1);
    await settleAll(a.jobIds);
    // Setelah final: kunci dilepas dari job lama → permintaan baru membuat job baru (operasi ulang tetap bisa).
    const c = await sendPasswordReset(db, send, { instance: "prod", allowedTypes: ALL, actor: SUPER, meta: META, userId: u.id });
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    expect(c.jobIds[0]).not.toBe(a.jobIds[0]);
    const old = (await jobsOf(a.jobIds))[0]!;
    expect(old.idempotencyKey).toBeNull();
    await settleAll(c.jobIds);
  });

  it("chain_aborted: langkah gagal → langkah berikutnya cancelled (tidak pernah ditulis ke spool) + audit", async () => {
    seen.length = 0;
    behave = (j) =>
      j.type === "kc_user_set_enabled" ? { state: "failed", exit_code: 3, error_code: "script_exit", result: null, tail: ["ERROR"] } : defaultBehavior(j);
    const u = (await db.select().from(users).where(eq(users.keycloakSub, KC_BUDI)))[0]!;
    const r = await setUserEnabled(db, send, { instance: "prod", allowedTypes: ALL, actor: SUPER, meta: META, userId: u.id, enabled: false });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.jobIds).toHaveLength(2); // kc_user_set_enabled → odoo_user_ensure@prod (akses aktif)
    const rows = await settleAll(r.jobIds);
    const first = rows.find((x) => x.type === "kc_user_set_enabled")!;
    const second = rows.find((x) => x.type === "odoo_user_ensure")!;
    expect(first.status).toBe("failed");
    expect(second).toMatchObject({ status: "cancelled", errorCode: "chain_aborted", afterJobId: first.id });
    expect(seen.map((j) => j.type)).toEqual(["kc_user_set_enabled"]);
    const ab = await db.select().from(auditLogs).where(eq(auditLogs.action, "job.chain_aborted"));
    expect(ab.some((x) => (x.metadata as { job_id?: string }).job_id === second.id)).toBe(true);
    // status users tidak berubah (job gagal)
    expect((await db.select().from(users).where(eq(users.id, u.id)))[0]!.status).toBe("active");
    behave = defaultBehavior;

    // Ulang (sukses) → disabled + disabled_at; tenant_user_access prod → revoked.
    const r2 = await setUserEnabled(db, send, { instance: "prod", allowedTypes: ALL, actor: SUPER, meta: META, userId: u.id, enabled: false });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    const rows2 = await settleAll(r2.jobIds);
    expect(rows2.every((x) => x.status === "succeeded")).toBe(true);
    const u3 = (await db.select().from(users).where(eq(users.id, u.id)))[0]!;
    expect(u3.status).toBe("disabled");
    expect(u3.disabledAt).not.toBeNull();
    const tua = (await db.select().from(tenantUserAccess).where(and(eq(tenantUserAccess.environmentId, envAcmeProd), eq(tenantUserAccess.email, "budi@acme.co.id"))))[0]!;
    expect(tua.status).toBe("revoked");
  });

  it("lintas tenant (client_admin acme): tenant lain / user tenant lain / admin kedua / role platform → ditolak tanpa job + audit rejected", async () => {
    const before = (await db.select().from(provisionJobs)).length;
    const beta = (await db.select().from(users).where(eq(users.keycloakSub, "beta-user-sub")))[0]!;
    const base = { instance: "prod" as const, allowedTypes: ALL, actor: CADMIN, meta: META };

    const a1 = await addUser(db, send, { ...base, clientId: betaId, email: "x@beta.co.id", name: null, cpRole: "client_user", odoo: {} });
    expect(a1).toEqual({ ok: false, reason: "authz", denial: "cross_tenant" });
    const a2 = await changeUserAccess(db, send, { ...base, userId: beta.id, cpRole: "client_user", odoo: {} });
    expect(a2).toEqual({ ok: false, reason: "authz", denial: "cross_tenant" });
    const a3 = await sendPasswordReset(db, send, { ...base, userId: beta.id });
    expect(a3).toEqual({ ok: false, reason: "authz", denial: "cross_tenant" });
    const a4 = await setUserEnabled(db, send, { ...base, userId: beta.id, enabled: false });
    expect(a4).toEqual({ ok: false, reason: "authz", denial: "cross_tenant" });
    const a5 = await addUser(db, send, { ...base, clientId: platformId, email: "x@bimacreative.tech", name: null, cpRole: "ops", odoo: {} });
    expect(a5).toEqual({ ok: false, reason: "authz", denial: "cross_tenant" });
    const a6 = await addUser(db, send, { ...base, clientId: acmeId, email: "boss@acme.co.id", name: null, cpRole: "client_admin", odoo: {} });
    expect(a6).toEqual({ ok: false, reason: "authz", denial: "one_admin" });
    const a7 = await addUser(db, send, { ...base, clientId: acmeId, email: "boss@acme.co.id", name: null, cpRole: "superadmin", odoo: {} });
    expect(a7).toEqual({ ok: false, reason: "authz", denial: "role_not_allowed" });
    // env milik tenant lain disisipkan ke form → env_unknown
    const a8 = await addUser(db, send, { ...base, clientId: acmeId, email: "c@acme.co.id", name: null, cpRole: "client_user", odoo: { "99999999-9999-4999-8999-999999999999": "admin" } });
    expect(a8).toEqual({ ok: false, reason: "precondition", detail: "env_unknown" });
    // email yang sudah terikat tenant lain
    const a9 = await addUser(db, send, { ...base, clientId: acmeId, email: "rina@beta.co.id", name: null, cpRole: "client_user", odoo: {} });
    expect(a9).toEqual({ ok: false, reason: "precondition", detail: "email_other_tenant" });
    // nama non-ASCII
    const a10 = await addUser(db, send, { ...base, clientId: acmeId, email: "d@acme.co.id", name: "José", cpRole: "client_user", odoo: {} });
    expect(a10).toEqual({ ok: false, reason: "precondition", detail: "name_invalid" });
    // ops: hanya baca
    const a11 = await addUser(db, send, { ...base, actor: { sub: "ops-sub", userId: null, roles: ["ops"] }, clientId: acmeId, email: "e@acme.co.id", name: null, cpRole: "client_user", odoo: {} });
    expect(a11).toEqual({ ok: false, reason: "authz", denial: "forbidden" });
    // fitur nonaktif di instance (allowlist lama)
    const a12 = await addUser(db, send, { ...base, allowedTypes: ["odoo_route"], clientId: acmeId, email: "f@acme.co.id", name: null, cpRole: "client_user", odoo: {} });
    expect(a12).toEqual({ ok: false, reason: "disabled" });

    expect((await db.select().from(provisionJobs)).length).toBe(before);
    const rej = await db.select().from(auditLogs).where(and(eq(auditLogs.result, "rejected"), eq(auditLogs.actorUserId, CADMIN.userId!)));
    expect(rej.length).toBeGreaterThanOrEqual(7);
    expect(rej.every((x) => !JSON.stringify(x.metadata).includes("@"))).toBe(true);

    // tenant sendiri, role client_user → boleh (scope own)
    const okr = await addUser(db, send, { ...base, clientId: acmeId, email: "sari@acme.co.id", name: "Sari", cpRole: "client_user", odoo: { [envAcmeDemo]: "user" } });
    expect(okr.ok).toBe(true);
    if (okr.ok) await settleAll(okr.jobIds);
  });

  it("satu admin di DB: users_one_tenant_admin_uq menolak admin kedua invited/active; reconcile tidak menggagalkan job", async () => {
    await expect(db.insert(users).values({ keycloakSub: "second-admin", role: "client_admin", clientId: acmeId, status: "invited" })).rejects.toThrow();
    await db.insert(users).values({ keycloakSub: "old-admin", role: "client_admin", clientId: acmeId, status: "disabled" });
  });

  it("watchdog: job rantai yang menunggu pendahulu aktif TIDAK di-no_result", async () => {
    const [head] = await db
      .insert(provisionJobs)
      .values({ type: "kc_user_action_email", env: "prod", status: "running", actor: "user:super-sub", clientId: acmeId, payload: { slug: "acme-co", args: { email: "z@acme.co.id", action: "UPDATE_PASSWORD" } }, deadlineAt: new Date(Date.now() + 3600_000), createdAt: new Date(Date.now() - 7200_000) })
      .returning();
    const [tail] = await db
      .insert(provisionJobs)
      .values({ type: "kc_user_action_email", env: "prod", status: "queued", actor: "user:super-sub", clientId: acmeId, afterJobId: head!.id, payload: { slug: "acme-co", args: { email: "z@acme.co.id", action: "UPDATE_PASSWORD" } }, createdAt: new Date(Date.now() - 7200_000) })
      .returning();
    await bridge.watchdog();
    expect((await jobsOf([tail!.id]))[0]!.status).toBe("queued");
    await db.update(provisionJobs).set({ status: "cancelled", finishedAt: new Date() }).where(inArray(provisionJobs.id, [head!.id]));
    await bridge.advanceChains();
    expect((await jobsOf([tail!.id]))[0]).toMatchObject({ status: "cancelled", errorCode: "chain_aborted" });
  });
});
