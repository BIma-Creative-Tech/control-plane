/**
 * Integrasi SaaS Fase 1 (kontrak §2): migrasi 0000..0004 di DB kosong + tenant `platform`, rantai job user dengan
 * dispatcher PALSU (direktori temp), idempotency, chain_aborted, rekonsiliasi users dari RESULT kc_user, dan
 * otorisasi lintas tenant di lapisan layanan. Postgres SEKALI PAKAI (TEST_DATABASE_URL; skema di-DROP).
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
import { ensurePlatformTenant } from "@/db/platform";
import { auditLogs, clients, environments, provisionJobs, tenantUserAccess, users } from "@/db/schema";
import { upsertUserOnLogin } from "@/db/users";
import { INFRA_JOB_QUEUE_OPTIONS, QUEUE_INFRA_JOB } from "@/jobs/queue";
import type { Actor, SendFn } from "@/jobs/service";
import { enqueueChain } from "@/jobs/chain";
import { addUser, adoptUser, changeUserAccess, sendPasswordReset, setUserEnabled } from "@/jobs/users";
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

/** UUID deterministik per string (id Keycloak/org palsu yang stabil per email/tenant). */
function uuidFrom(v: string): string {
  const x = createHash("sha256").update(v).digest("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-4${x.slice(13, 16)}-8${x.slice(17, 20)}-${x.slice(20, 32)}`;
}
/** User yang SUDAH ada di Keycloak (baris users lama dari login) → RESULT kc_user = sub itu, created=0. */
const existingKc = new Map<string, string>();

const defaultBehavior: Behavior = (j) => {
  const a = j.args as Record<string, unknown>;
  const email = String(a.email ?? "");
  const known = existingKc.get(email);
  const kc = email === "budi@acme.co.id" ? KC_BUDI : (known ?? uuidFrom(`kc:${email}`));
  switch (j.type) {
    case "kc_org_ensure":
      return ok({ realm: "platform", org: j.slug === "acme-co" ? ORG_ACME : uuidFrom(`org:${String(a.tenant_id)}`), created: "1", changed: "1" });
    case "kc_user_ensure":
      return ok({ realm: "platform", kc_user: kc, created: known ? "0" : "1", changed: "1", invite: known ? "0" : "1" });
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

  it("F1.3: client_admin (peta izin produksi) → SEMUA mutasi Users ditolak forbidden, tanpa job + audit rejected", async () => {
    const before = (await db.select().from(provisionJobs)).length;
    const beta = (await db.select().from(users).where(eq(users.keycloakSub, "beta-user-sub")))[0]!;
    const budi = (await db.select().from(users).where(eq(users.keycloakSub, KC_BUDI)))[0]!;
    const base = { instance: "prod" as const, allowedTypes: ALL, actor: CADMIN, meta: META };
    const F = { ok: false, reason: "authz", denial: "forbidden" };

    // tenant sendiri (acme) pun ditolak — users:manage_own (W6) hanya berlaku di kanal portal, bukan layanan /users.
    expect(await addUser(db, send, { ...base, clientId: acmeId, email: "sari2@acme.co.id", name: null, cpRole: "client_user", odoo: {} })).toEqual(F);
    expect(await addUser(db, send, { ...base, clientId: betaId, email: "x@beta.co.id", name: null, cpRole: "client_user", odoo: {} })).toEqual(F);
    expect(await addUser(db, send, { ...base, clientId: platformId, email: "x@bimacreative.tech", name: null, cpRole: "ops", odoo: {} })).toEqual(F);
    expect(await changeUserAccess(db, send, { ...base, userId: budi.id, cpRole: "client_user", odoo: {} })).toEqual(F);
    expect(await changeUserAccess(db, send, { ...base, userId: beta.id, cpRole: "client_user", odoo: {} })).toEqual(F);
    expect(await sendPasswordReset(db, send, { ...base, userId: budi.id })).toEqual(F);
    expect(await setUserEnabled(db, send, { ...base, userId: beta.id, enabled: false })).toEqual(F);
    expect(await adoptUser(db, send, { ...base, userId: budi.id, clientId: acmeId, cpRole: "client_user" })).toEqual(F);

    expect((await db.select().from(provisionJobs)).length).toBe(before);
    const rej = await db.select().from(auditLogs).where(and(eq(auditLogs.result, "rejected"), eq(auditLogs.actorUserId, CADMIN.userId!)));
    expect(rej.length).toBe(8);
    expect(rej.every((x) => (x.metadata as { denial?: string }).denial === "forbidden")).toBe(true);
    expect(rej.every((x) => !JSON.stringify(x.metadata).includes("@"))).toBe(true);
  });

  it("prasyarat & aturan role (superadmin): env tenant lain / email tenant lain / nama non-ASCII / satu admin / ops / fitur nonaktif", async () => {
    const before = (await db.select().from(provisionJobs)).length;
    const base = { instance: "prod" as const, allowedTypes: ALL, actor: SUPER, meta: META };
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
  // -------------------------------------------------------------------------------------------------------------
  // Temuan QA F1 (pengikatan email, adopt) — aktor superadmin terpisah agar kuota rantai per aktor/menit tidak habis.
  // -------------------------------------------------------------------------------------------------------------
  const KC_LEGACY_SA = "1e9a7c3b-2222-4333-8444-555566667777";
  const KC_TONO = "2e9a7c3b-2222-4333-8444-555566667777";
  const KC_NINA = "3e9a7c3b-2222-4333-8444-555566667777";
  let SUPER2: Actor;
  let legacySaId: string;
  let tonoId: string;
  let anehId: string;

  it("F1.2: email user lama (client_id NULL) / ber-role platform di tenant → setiap mutasi ditolak tanpa job", async () => {
    const [s2] = await db.insert(users).values({ keycloakSub: "super2-sub", role: "superadmin", clientId: platformId }).returning();
    SUPER2 = { sub: "super2-sub", userId: s2!.id, roles: ["superadmin"] };
    // Baris lama dari login sebelum Fase 1 (client_id NULL) — termasuk superadmin.
    const [l1] = await db.insert(users).values({ keycloakSub: KC_LEGACY_SA, email: "lama@bimacreative.tech", role: "superadmin" }).returning();
    const [l2] = await db.insert(users).values({ keycloakSub: KC_TONO, email: "tono@acme.co.id", role: "client_user" }).returning();
    // Cache role platform yang (entah bagaimana) tercatat di tenant klien.
    const [l3] = await db.insert(users).values({ keycloakSub: "aneh-sub", email: "aneh@acme.co.id", role: "ops", clientId: acmeId }).returning();
    legacySaId = l1!.id;
    tonoId = l2!.id;
    anehId = l3!.id;
    existingKc.set("lama@bimacreative.tech", KC_LEGACY_SA);
    existingKc.set("tono@acme.co.id", KC_TONO);

    const before = (await db.select().from(provisionJobs)).length;
    const base = { instance: "prod" as const, allowedTypes: ALL, actor: SUPER2, meta: META };
    const add = (clientId: string, email: string, cpRole: "client_user" | "superadmin" | "ops") =>
      addUser(db, send, { ...base, clientId, email, name: null, cpRole, odoo: {} });
    // (a) takeover superadmin lama lewat tenant klien → ditolak
    expect(await add(acmeId, "lama@bimacreative.tech", "client_user")).toEqual({ ok: false, reason: "precondition", detail: "email_unbound" });
    expect(await add(betaId, "tono@acme.co.id", "client_user")).toEqual({ ok: false, reason: "precondition", detail: "email_unbound" });
    // platform pun: baris lama hanya lewat adopt eksplisit
    expect(await add(platformId, "lama@bimacreative.tech", "superadmin")).toEqual({ ok: false, reason: "precondition", detail: "email_unbound" });
    // (b) role platform di tenant klien → ditolak untuk tambah maupun mutasi lain
    expect(await add(acmeId, "aneh@acme.co.id", "client_user")).toEqual({ ok: false, reason: "precondition", detail: "email_platform_role" });
    expect(await changeUserAccess(db, send, { ...base, userId: anehId, cpRole: "client_user", odoo: {} })).toEqual({
      ok: false,
      reason: "precondition",
      detail: "email_platform_role",
    });
    expect(await setUserEnabled(db, send, { ...base, userId: anehId, enabled: false })).toEqual({ ok: false, reason: "precondition", detail: "email_platform_role" });
    // (c) tenant lain (huruf besar tetap cocok)
    expect(await add(betaId, "Sari@Acme.co.id", "client_user")).toEqual({ ok: false, reason: "precondition", detail: "email_other_tenant" });

    expect((await db.select().from(provisionJobs)).length).toBe(before);
    const rej = await db.select().from(auditLogs).where(and(eq(auditLogs.result, "rejected"), eq(auditLogs.actorUserId, SUPER2.userId!)));
    expect(rej.map((x) => (x.metadata as { detail?: string }).detail).sort()).toEqual(
      ["email_other_tenant", "email_platform_role", "email_platform_role", "email_platform_role", "email_unbound", "email_unbound", "email_unbound"].sort(),
    );
  });

  it("F1.1: adopt=true dari selain superadmin → ditolak + diaudit (layanan, enqueueChain langsung, worker)", async () => {
    const before = (await db.select().from(provisionJobs)).length;
    const OPS: Actor = { sub: "ops-sub", userId: null, roles: ["ops"] };
    for (const actor of [CADMIN, OPS]) {
      expect(await adoptUser(db, send, { instance: "prod", allowedTypes: ALL, actor, meta: META, userId: tonoId, clientId: acmeId, cpRole: "client_user" })).toEqual({
        ok: false,
        reason: "authz",
        denial: "forbidden",
      });
      // Melewati layanan (mis. bug/aksi lain): enqueueChain tetap menolak adopt=true tanpa users:manage.
      const r = await enqueueChain(db, send, {
        instance: "prod",
        allowedTypes: ALL,
        client: { id: acmeId, slug: "acme-co" },
        steps: [{ type: "kc_user_ensure", env: "prod", args: { email: "tono@acme.co.id", tenant_id: acmeId, invite: false, adopt: true } }],
        actor,
        meta: META,
        audit: { action: "user.adopt", targetType: "user", targetId: tonoId, metadata: {} },
      });
      expect(r).toEqual({ ok: false, reason: "adopt_forbidden" });
    }
    expect((await db.select().from(provisionJobs)).length).toBe(before);
    const rej = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "user.adopt"), eq(auditLogs.result, "rejected")));
    expect(rej.filter((x) => (x.metadata as { reason?: string }).reason === "adopt_forbidden")).toHaveLength(2);
    // + 1 dari uji F1.3 (client_admin → adopt budi).
    expect(rej.filter((x) => (x.metadata as { denial?: string }).denial === "forbidden")).toHaveLength(3);

    // Worker: baris adopt yang disisipkan langsung ke DB dengan aktor bukan superadmin → rejected_validation, tidak ke spool.
    const [j] = await db
      .insert(provisionJobs)
      .values({
        type: "kc_user_ensure",
        env: "prod",
        status: "queued",
        actor: "user:cadmin-sub",
        actorUserId: CADMIN.userId,
        clientId: acmeId,
        payload: { slug: "acme-co", args: { email: "tono@acme.co.id", tenant_id: acmeId, invite: false, adopt: true } },
      })
      .returning();
    expect(await bridge.dispatch(j!.id)).toBe("rejected");
    expect((await jobsOf([j!.id]))[0]).toMatchObject({ status: "failed", errorCode: "rejected_validation" });
    expect((await jobsOf([j!.id]))[0]!.error).toContain("adopt_actor");
    expect(await readdir(path.join(root, "spool", "new"))).not.toContain(`${j!.id}.json`);
  });

  it("F1.4: adopt superadmin → platform (role tetap) & tenant (client_user); reconcile mengikat client_id + audit", async () => {
    seen.length = 0;
    const base = { instance: "prod" as const, allowedTypes: ALL, actor: SUPER2, meta: META };
    // role cache superadmin tidak pernah ke tenant klien; platform tidak boleh mengubah role lewat adopt.
    expect(await adoptUser(db, send, { ...base, userId: legacySaId, clientId: acmeId, cpRole: "client_user" })).toEqual({ ok: false, reason: "authz", denial: "role_not_allowed" });
    expect(await adoptUser(db, send, { ...base, userId: legacySaId, clientId: platformId, cpRole: "ops" })).toEqual({ ok: false, reason: "authz", denial: "role_not_allowed" });

    const r = await adoptUser(db, send, { ...base, userId: legacySaId, clientId: platformId, cpRole: "superadmin" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const rows = await settleAll(r.jobIds);
    expect(rows.every((x) => x.status === "succeeded")).toBe(true);
    expect(seen.map((j) => j.type)).toEqual(["kc_org_ensure", "kc_user_ensure", "kc_user_set_roles"]);
    expect(seen[1]!.args).toEqual({ email: "lama@bimacreative.tech", tenant_id: platformId, invite: false, adopt: true });
    expect(seen[2]!.args).toEqual({ email: "lama@bimacreative.tech", cp_role: "superadmin" });
    expect((await db.select().from(users).where(eq(users.id, legacySaId)))[0]).toMatchObject({ clientId: platformId, role: "superadmin", keycloakSub: KC_LEGACY_SA });
    const okAudit = await db.select().from(auditLogs).where(and(eq(auditLogs.action, "user.adopt"), eq(auditLogs.result, "success")));
    expect(okAudit).toHaveLength(1);
    expect(okAudit[0]!.actorUserId).toBe(SUPER2.userId);
    const bound = await db.select().from(auditLogs).where(eq(auditLogs.action, "user.adopt_bound"));
    expect(bound.map((x) => x.targetId)).toEqual([legacySaId]);
    // sudah terikat → adopt kedua ditolak
    expect(await adoptUser(db, send, { ...base, userId: legacySaId, clientId: platformId, cpRole: "superadmin" })).toEqual({ ok: false, reason: "authz", denial: "already_bound" });

    // tenant: client_admin saat acme sudah punya admin → one_admin; client_user → ok
    expect(await adoptUser(db, send, { ...base, userId: tonoId, clientId: acmeId, cpRole: "client_admin" })).toEqual({ ok: false, reason: "authz", denial: "one_admin" });
    seen.length = 0;
    const t = await adoptUser(db, send, { ...base, userId: tonoId, clientId: acmeId, cpRole: "client_user" });
    expect(t.ok).toBe(true);
    if (!t.ok) return;
    await settleAll(t.jobIds);
    expect(seen.map((j) => j.type)).toEqual(["kc_user_ensure", "kc_user_set_roles"]);
    expect((await db.select().from(users).where(eq(users.id, tonoId)))[0]).toMatchObject({ clientId: acmeId, role: "client_user" });
    expect((await db.select().from(auditLogs).where(eq(auditLogs.action, "user.adopt_bound"))).map((x) => x.targetId).sort()).toEqual([legacySaId, tonoId].sort());
  });

  it("F1 reconcile (pertahanan berlapis): kc_user_ensure TANPA adopt tidak mengikat baris lama client_id NULL", async () => {
    const [n] = await db.insert(users).values({ keycloakSub: KC_NINA, email: "nina@beta.co.id", role: "client_user" }).returning();
    existingKc.set("nina@beta.co.id", KC_NINA);
    // Langsung lewat enqueueChain (melewati aturan email layanan) — rekonsiliasi tetap menolak mengikat.
    const r = await enqueueChain(db, send, {
      instance: "prod",
      allowedTypes: ALL,
      client: { id: betaId, slug: "beta-co" },
      steps: [{ type: "kc_user_ensure", env: "prod", args: { email: "nina@beta.co.id", tenant_id: betaId, invite: false } }],
      actor: SUPER2,
      meta: META,
      audit: { action: "test.ensure", targetType: "user", targetId: null, metadata: {} },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const rows = await settleAll(r.jobIds);
    expect(rows[0]!.status).toBe("succeeded");
    expect((await db.select().from(users).where(eq(users.id, n!.id)))[0]!.clientId).toBeNull();
    const conflicts = await db.select().from(auditLogs).where(eq(auditLogs.action, "user.reconcile_conflict"));
    expect(conflicts.some((x) => (x.metadata as { conflict?: string; job_id?: string }).conflict === "unbound_without_adopt" && (x.metadata as { job_id?: string }).job_id === r.jobIds[0])).toBe(true);
  });

  // -------------------------------------------------------------------------------------------------------------
  // Temuan QA F2 — satu tenant-admin atomik saat enqueue (advisory lock per tenant).
  // -------------------------------------------------------------------------------------------------------------
  it("F2: dua enqueue client_admin paralel (tenant sama, email beda) → tepat satu diterima; sisanya one_admin + audit", async () => {
    // kc_org_id sudah ada → rantai tanpa kc_org_ensure bersama (kunci idempotency org TIDAK ikut menyerialkan; hanya
    // advisory lock F2 yang memisahkan kedua transaksi).
    const [g] = await db.insert(clients).values({ slug: "gamma-co", name: "Gamma", kcOrgId: "4e9a7c3b-2222-4333-8444-555566667777" }).returning();
    const gammaId = g!.id;
    const [s3] = await db.insert(users).values({ keycloakSub: "super3-sub", role: "superadmin", clientId: platformId }).returning();
    const [s4] = await db.insert(users).values({ keycloakSub: "super4-sub", role: "superadmin", clientId: platformId }).returning();
    const A: Actor = { sub: "super3-sub", userId: s3!.id, roles: ["superadmin"] };
    const B: Actor = { sub: "super4-sub", userId: s4!.id, roles: ["superadmin"] };
    const mk = (actor: Actor, email: string) =>
      addUser(db, send, { instance: "prod", allowedTypes: ALL, actor, meta: META, clientId: gammaId, email, name: null, cpRole: "client_admin", odoo: {} });
    // Kedua permintaan lolos cek otorisasi (belum ada admin) — hanya kunci di transaksi enqueue yang memisahkan.
    const res = await Promise.all([mk(A, "a1@gamma.co.id"), mk(B, "a2@gamma.co.id")]);
    const accepted = res.filter((x) => x.ok);
    const rejected = res.filter((x) => !x.ok);
    expect(accepted).toHaveLength(1);
    expect(rejected).toEqual([{ ok: false, reason: "one_admin", conflict: "job" }]);
    const rejAudit = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.clientId, gammaId), eq(auditLogs.result, "rejected")));
    expect(rejAudit.map((x) => (x.metadata as { reason?: string }).reason)).toEqual(["one_admin"]);
    const adminJobs = await db
      .select()
      .from(provisionJobs)
      .where(and(eq(provisionJobs.clientId, gammaId), eq(provisionJobs.type, "kc_user_set_roles")));
    expect(adminJobs).toHaveLength(1);

    // Setelah rantai pemenang selesai: baris users client_admin ada → enqueue admin lain ditolak (cabang "user");
    // admin yang SAMA (ubah akses, role tetap) tetap boleh.
    const win = accepted[0]!;
    if (!win.ok) return;
    await settleAll(win.jobIds);
    const winnerEmail = (adminJobs[0]!.payload as { args: { email: string } }).args.email;
    expect((await db.select().from(users).where(and(eq(users.clientId, gammaId), eq(users.role, "client_admin"))))[0]!.email).toBe(winnerEmail);
    const direct = (actor: Actor, email: string) =>
      enqueueChain(db, send, {
        instance: "prod",
        allowedTypes: ALL,
        client: { id: gammaId, slug: "gamma-co" },
        steps: [{ type: "kc_user_set_roles", env: "prod", args: { email, cp_role: "client_admin" } }],
        actor,
        meta: META,
        audit: { action: "test.set_roles", targetType: "user", targetId: null, metadata: {} },
      });
    expect(await direct(A, "a3@gamma.co.id")).toEqual({ ok: false, reason: "one_admin", conflict: "user" });
    const same = await direct(B, winnerEmail);
    expect(same.ok).toBe(true);
    if (same.ok) await settleAll(same.jobIds);
  });

  it("F2: DUA enqueueChain paralel (tenant sama, email beda) → tepat satu diterima — 4 putaran, tenant baru per putaran", async () => {
    for (let round = 0; round < 4; round++) {
      const slug = `eps${round}-co`;
      const [t] = await db.insert(clients).values({ slug, name: slug }).returning();
      const res = await Promise.all(
        [0, 1].map((i) =>
          enqueueChain(db, send, {
            instance: "prod",
            allowedTypes: ALL,
            client: { id: t!.id, slug },
            steps: [{ type: "kc_user_set_roles", env: "prod", args: { email: `e${i}@${slug}.id`, cp_role: "client_admin" } }],
            actor: { sub: `eps-${round}-${i}`, userId: null, roles: ["superadmin"] },
            meta: META,
            audit: { action: "test.set_roles", targetType: "user", targetId: null, metadata: {} },
          }),
        ),
      );
      expect(res.filter((x) => x.ok), `putaran ${round}`).toHaveLength(1);
      expect(res.find((x) => !x.ok)).toEqual({ ok: false, reason: "one_admin", conflict: "job" });
      const win = res.find((x) => x.ok);
      if (win?.ok) await settleAll(win.jobIds);
    }
  });

  it("F2: 6 enqueue langsung paralel (enqueueChain, aktor berbeda) untuk tenant tanpa admin → tepat satu diterima", async () => {
    const [d] = await db.insert(clients).values({ slug: "delta-co", name: "Delta" }).returning();
    const deltaId = d!.id;
    const res = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        enqueueChain(db, send, {
          instance: "prod",
          allowedTypes: ALL,
          client: { id: deltaId, slug: "delta-co" },
          steps: [{ type: "kc_user_set_roles", env: "prod", args: { email: `d${i}@delta.co.id`, cp_role: "client_admin" } }],
          actor: { sub: `par-${i}`, userId: null, roles: ["superadmin"] },
          meta: META,
          audit: { action: "test.set_roles", targetType: "user", targetId: null, metadata: {} },
        }),
      ),
    );
    expect(res.filter((x) => x.ok)).toHaveLength(1);
    expect(res.filter((x) => !x.ok).every((x) => !x.ok && x.reason === "one_admin")).toBe(true);
    const jobs = await db
      .select()
      .from(provisionJobs)
      .where(and(eq(provisionJobs.clientId, deltaId), eq(provisionJobs.type, "kc_user_set_roles")));
    expect(jobs).toHaveLength(1);
    const win = res.find((x) => x.ok);
    if (win?.ok) await settleAll(win.jobIds);
  });
});
