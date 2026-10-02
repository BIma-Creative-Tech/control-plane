/**
 * Integrasi ADR 0018 (W5/W7): subscription → Go-live → garansi → aktif (+ invoice) → lewat jatuh tempo → ditangguhkan
 * (+ tenant_suspend per env instance, idempoten) → lunas (+ tenant_resume); implementation tidak pernah disuspend;
 * rekonsiliasi RESULT state/mode lewat dispatcher PALSU; pengingat email idempoten (Mailpit sekali pakai bila
 * TEST_MAILPIT_SMTP/TEST_MAILPIT_API diisi — selain itu mailer perekam); cek tenant-admin; schedule pg-boss 00:15 WIB.
 * Postgres SEKALI PAKAI (TEST_DATABASE_URL; skema di-DROP).
 */
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { and, eq, inArray, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { PgBoss, fromDrizzle } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSmtpMailer, type MailMessage, type Mailer } from "@/billing/mailer";
import {
  createSubscription,
  goLiveSubscription,
  issueInvoice,
  markInvoicePaid,
  setSubscriptionPrice,
  terminateSubscription,
  voidInvoice,
  type BillingServiceInput,
} from "@/billing/service";
import { runSubscriptionTick, type TickDeps } from "@/billing/tick";
import { createDb, type Db } from "@/db/client";
import { ensureInitialPlans } from "@/db/plans";
import { ensurePlatformTenant } from "@/db/platform";
import { auditLogs, clients, environments, invoices, notificationLog, plans, provisionJobs, subscriptions, users } from "@/db/schema";
import { INFRA_JOB_QUEUE_OPTIONS, QUEUE_INFRA_JOB } from "@/jobs/queue";
import type { Actor, SendFn } from "@/jobs/service";
import { dateToTimestamp, timestampToDate } from "@/lib/billing";
import { BRIDGE_JOB_TYPES, type JobFile } from "@/lib/job-contract";
import { QUEUE_SUBSCRIPTION_TICK, createTickRunner, registerSubscriptionTick } from "@/worker/billing";
import { createBridge, type Bridge } from "@/worker/bridge";
import { registerInfraJobWorker } from "@/worker/register";

const URL_ = process.env.TEST_DATABASE_URL;
const MP_SMTP = process.env.TEST_MAILPIT_SMTP; // host:port
const MP_API = process.env.TEST_MAILPIT_API; // http://host:8025
const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
const META = { ip: "203.0.113.7", requestId: "req-billing" };
const ADMIN_EMAIL = "admin@acme.co.id";
const BILLING = "billing@bimacreative.tech";

type Res = { state: "succeeded" | "failed"; exit_code: number | null; error_code: string | null; result: Record<string, string> | null; tail: string[] };
const ok = (result: Record<string, string>): Res => ({ state: "succeeded", exit_code: 0, error_code: null, result, tail: [] });

function behave(j: JobFile): Res {
  switch (j.type) {
    case "tenant_suspend":
      return ok({ route: `${j.slug}-${j.env}.yml`, state: "suspended", changed: "1" });
    case "tenant_resume":
      return ok({ route: `${j.slug}-${j.env}.yml`, state: "active", changed: "1" });
    default:
      return ok({ changed: "0" });
  }
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

/** Jam 07:00 WIB pada tanggal `d` (instant "sekarang" yang konsisten dengan tanggal tick). */
const at = (d: string) => new Date(dateToTimestamp(d).getTime() + 7 * 3600_000);

interface MailpitMessage {
  Subject: string;
  To: { Address: string }[];
  Cc: { Address: string }[] | null;
}

async function mailpit(): Promise<MailpitMessage[]> {
  const r = await fetch(`${MP_API}/api/v1/messages?limit=200`);
  const j = (await r.json()) as { total: number; messages: MailpitMessage[] };
  return j.messages;
}

describe.skipIf(!URL_)("Billing: siklus langganan ⇄ tick ⇄ dispatcher palsu ⇄ email", () => {
  let db: Db;
  let pool: { end: () => Promise<void> };
  let workerBoss: PgBoss;
  let webBoss: PgBoss;
  let send: SendFn;
  let root: string;
  let bridge: Bridge;
  const seen: JobFile[] = [];
  const sent: MailMessage[] = [];
  /** Email pengingat saja (tanpa laporan harian tenant-admin). */
  const reminders = () => sent.filter((m) => !/tanpa tenant-admin/.test(m.subject));
  let mailer: Mailer;
  let acmeId: string;
  let betaId: string;
  let envProd: string;
  let envDemo: string;
  let envStaging: string;
  let SUPER: Actor;
  let OPS: Actor;
  let subId: string;
  const ALL = [...BRIDGE_JOB_TYPES];

  const svc = (actor: Actor, now?: Date): BillingServiceInput => ({ actor, meta: META, instance: "prod", allowedTypes: ALL, send, ...(now ? { now } : {}) });
  const tickDeps = (today: string, o: Partial<TickDeps> = {}): TickDeps => ({
    db,
    send,
    instance: "prod",
    allowedTypes: ALL,
    logger: quiet,
    mailer,
    billingEmail: BILLING,
    now: at(today),
    today,
    ...o,
  });
  const sub = async (id = subId) => {
    const r = (await db.select().from(subscriptions).where(eq(subscriptions.id, id)))[0]!;
    return { ...r, startsAt: timestampToDate(r.currentPeriodStart), endsAt: timestampToDate(r.currentPeriodEnd), grace: timestampToDate(r.graceUntil) };
  };

  async function fakeDispatchOnce() {
    const newDir = path.join(root, "spool", "new");
    for (const name of (await readdir(newDir)).sort()) {
      await rename(path.join(newDir, name), path.join(root, "work", name));
      const job = JSON.parse(await readFile(path.join(root, "work", name), "utf8")) as JobFile;
      seen.push(job);
      const b = behave(job);
      const tmp = path.join(root, "results", `.${name}.tmp`);
      const now = new Date().toISOString();
      await writeFile(tmp, JSON.stringify({ v: 1, job_id: job.job_id, ...b, started_at: now, finished_at: now, duration_ms: 3 }));
      await rename(tmp, path.join(root, "results", name));
    }
  }
  const settle = (ids: string[]) =>
    waitFor(async () => {
      await fakeDispatchOnce();
      await bridge.tick();
      const rows = await db.select().from(provisionJobs).where(inArray(provisionJobs.id, ids));
      return rows.every((r) => ["succeeded", "failed", "cancelled"].includes(r.status)) ? rows : null;
    });

  beforeAll(async () => {
    ({ db, pool } = createDb(URL_!, { max: 4, applicationName: "cp-int-billing" }));
    await db.execute(sql`DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA IF EXISTS pgboss CASCADE; CREATE SCHEMA public;`);
    await migrate(db, { migrationsFolder: "./drizzle" });
    const platform = await ensurePlatformTenant(db);
    await ensureInitialPlans(db);
    await db.update(plans).set({ priceAmount: "1500000" }).where(eq(plans.code, "odoo-shared-m"));

    workerBoss = new PgBoss({ connectionString: URL_!, schema: "pgboss", max: 2 });
    workerBoss.on("error", () => undefined);
    await workerBoss.start();
    await workerBoss.createQueue(QUEUE_INFRA_JOB, INFRA_JOB_QUEUE_OPTIONS);
    webBoss = new PgBoss({ connectionString: URL_!, schema: "pgboss", max: 1, migrate: false, supervise: false, schedule: false });
    webBoss.on("error", () => undefined);
    await webBoss.start();
    send = (tx, id) => webBoss.send(QUEUE_INFRA_JOB, { provisionJobId: id }, { db: fromDrizzle(tx, sql), ...INFRA_JOB_QUEUE_OPTIONS });

    root = await mkdtemp(path.join(tmpdir(), "cp-int-billing-"));
    for (const d of ["spool/tmp", "spool/new", "work", "results"]) await mkdir(path.join(root, d), { recursive: true });
    bridge = createBridge({ db, instance: "prod", spoolDir: path.join(root, "spool"), resultsDir: path.join(root, "results"), queueGraceSeconds: 900, logger: quiet });
    await registerInfraJobWorker(workerBoss, bridge, quiet, { pollingIntervalSeconds: 0.5 });

    let smtp: Mailer | null = null;
    if (MP_SMTP && MP_API) {
      const [host, port] = MP_SMTP.split(":");
      const pwFile = path.join(root, "smtp_password");
      await writeFile(pwFile, "testonly-not-a-secret\n", { mode: 0o600 });
      smtp = createSmtpMailer({ host: host!, port: Number(port), user: "noreply@bimacreative.tech", passwordFile: pwFile, from: "noreply@bimacreative.tech", tls: "off" });
      await fetch(`${MP_API}/api/v1/messages`, { method: "DELETE" });
    }
    mailer = {
      async send(m) {
        sent.push(m);
        if (smtp) await smtp.send(m);
      },
    };

    const [a] = await db.insert(clients).values({ slug: "acme-co", name: "Acme Corp" }).returning();
    const [b] = await db.insert(clients).values({ slug: "beta-co", name: "Beta" }).returning();
    acmeId = a!.id;
    betaId = b!.id;
    const env = (kind: "prod" | "demo" | "staging", host: string) => ({
      clientId: acmeId,
      kind,
      odooInstance: "pool-a",
      dbName: `acme_co_${kind}`,
      url: `https://${host}`,
      host,
      dbStatus: "provisioned" as const,
      routeStatus: "active" as const,
    });
    envProd = (await db.insert(environments).values(env("prod", "acme-co.erp.bimacreative.tech")).returning())[0]!.id;
    envDemo = (await db.insert(environments).values(env("demo", "acme-demo.erp.bimacreative.tech")).returning())[0]!.id;
    envStaging = (await db.insert(environments).values(env("staging", "acme-co.staging.bimacreative.tech")).returning())[0]!.id;

    const [sa] = await db.insert(users).values({ keycloakSub: "super-sub", role: "superadmin", clientId: platform.id }).returning();
    const [op] = await db.insert(users).values({ keycloakSub: "ops-sub", role: "ops", clientId: platform.id }).returning();
    await db.insert(users).values({ keycloakSub: "acme-admin-sub", email: ADMIN_EMAIL, role: "client_admin", status: "invited", clientId: acmeId });
    SUPER = { sub: "super-sub", userId: sa!.id, roles: ["superadmin"] };
    OPS = { sub: "ops-sub", userId: op!.id, roles: ["ops"] };
  }, 60_000);

  afterAll(async () => {
    await workerBoss?.stop({ graceful: false, timeout: 2000 }).catch(() => undefined);
    await webBoss?.stop({ graceful: false, timeout: 2000 }).catch(() => undefined);
    await pool?.end();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("buat subscription: implementation; satu per layanan; ops/platform ditolak + diaudit", async () => {
    const plan = (await db.select().from(plans).where(eq(plans.code, "odoo-shared-m")))[0]!;
    expect(await createSubscription(db, svc(OPS), { clientId: acmeId, planId: plan.id })).toEqual({ ok: false, reason: "forbidden" });
    const r = await createSubscription(db, svc(SUPER), { clientId: acmeId, planId: plan.id, notes: "kontrak 2026" });
    expect(r.ok).toBe(true);
    subId = (r as { id: string }).id;
    expect((await sub()).status).toBe("implementation");
    const shared = (await db.select().from(plans).where(eq(plans.code, "odoo-shared-s")))[0]!;
    expect(await createSubscription(db, svc(SUPER), { clientId: acmeId, planId: shared.id })).toEqual({ ok: false, reason: "service_exists" });
    const platformId = (await db.select().from(clients).where(eq(clients.slug, "platform")))[0]!.id;
    expect(await createSubscription(db, svc(SUPER), { clientId: platformId, planId: plan.id })).toEqual({ ok: false, reason: "tenant_inactive" });
    const audits = await db.select().from(auditLogs).where(eq(auditLogs.action, "subscription.create"));
    expect(audits.map((x) => x.result).sort()).toEqual(["rejected", "rejected", "rejected", "success"]);
    expect(audits.find((x) => x.result === "success")).toMatchObject({ actor: "user:super-sub", actorUserId: SUPER.userId, clientId: acmeId, targetId: subId });
  });

  it("implementation tidak pernah disuspend/diubah tick (tanggal jauh di depan)", async () => {
    const rep = await runSubscriptionTick(tickDeps("2031-01-01", { mailer: null }));
    expect(rep.transitions).toBe(0);
    expect((await sub()).status).toBe("implementation");
    expect(await db.select().from(provisionJobs)).toHaveLength(0);
  });

  it("Go-live: warranty, garansi +2 bulan; ulang → billing_status; tanggal depan → future_date", async () => {
    const now = at("2026-10-03");
    expect(await goLiveSubscription(db, svc(SUPER, now), { subscriptionId: subId, goLiveAt: "2026-10-04" })).toEqual({ ok: false, reason: "future_date" });
    expect((await goLiveSubscription(db, svc(SUPER, now), { subscriptionId: subId, goLiveAt: "2026-10-01" })).ok).toBe(true);
    const s = await sub();
    expect(s).toMatchObject({ status: "warranty", goLiveAt: "2026-10-01", warrantyUntil: "2026-12-01" });
    expect(await goLiveSubscription(db, svc(SUPER, now), { subscriptionId: subId, goLiveAt: "2026-10-01" })).toEqual({ ok: false, reason: "billing_status" });
  });

  it("invoice implementasi: nomor INV/YYYY/MM/NNNN berurutan; lunas oleh ops (catat saja); void", async () => {
    const now = at("2026-10-03");
    const i1 = await issueInvoice(db, svc(SUPER, now), { clientId: acmeId, kind: "implementation", amount: "25000000", dueAt: "2026-10-17" });
    const i2 = await issueInvoice(db, svc(SUPER, now), { clientId: acmeId, subscriptionId: subId, kind: "implementation", amount: "1000", dueAt: "2026-10-17" });
    expect(i1.ok && i2.ok).toBe(true);
    const rows = await db.select().from(invoices).orderBy(invoices.number);
    expect(rows.map((r) => r.number)).toEqual(["INV/2026/10/0001", "INV/2026/10/0002"]);
    // maintenance saat garansi → billing_status
    expect(await issueInvoice(db, svc(SUPER, now), { clientId: acmeId, subscriptionId: subId, kind: "maintenance", amount: "1", dueAt: "2026-10-17" })).toEqual({
      ok: false,
      reason: "billing_status",
    });
    // subscription tenant lain → not_found (id form tidak dipercaya)
    expect(await issueInvoice(db, svc(SUPER, now), { clientId: betaId, subscriptionId: subId, kind: "implementation", amount: "1", dueAt: "2026-10-17" })).toEqual({
      ok: false,
      reason: "not_found",
    });
    const id1 = (i1 as { id: string }).id;
    expect(await markInvoicePaid(db, svc(OPS, now), { invoiceId: id1, paidAt: "2026-10-04", paymentReference: "BCA 1", proofReference: "mutasi" })).toEqual({
      ok: false,
      reason: "future_date",
    });
    expect((await markInvoicePaid(db, svc(OPS, now), { invoiceId: id1, paidAt: "2026-10-02", paymentReference: "BCA 1", proofReference: "mutasi 2 Okt" })).ok).toBe(true);
    const paid = (await db.select().from(invoices).where(eq(invoices.id, id1)))[0]!;
    expect(paid).toMatchObject({ status: "paid", paymentReference: "BCA 1", proofReference: "mutasi 2 Okt", confirmedBy: OPS.userId });
    expect(timestampToDate(paid.paidAt)).toBe("2026-10-02");
    expect((await sub()).status).toBe("warranty");
    expect(await markInvoicePaid(db, svc(OPS, now), { invoiceId: id1, paidAt: "2026-10-02", paymentReference: "x", proofReference: "y" })).toEqual({
      ok: false,
      reason: "invoice_state",
    });
    expect(await voidInvoice(db, svc(OPS, now), { invoiceId: (i2 as { id: string }).id, reason: "dobel" })).toEqual({ ok: false, reason: "forbidden" });
    expect((await voidInvoice(db, svc(SUPER, now), { invoiceId: (i2 as { id: string }).id, reason: "dobel" })).ok).toBe(true);
  });

  it("H-14 garansi: satu email ke tenant-admin + cc billing; tick ulang tidak mengirim lagi", async () => {
    await runSubscriptionTick(tickDeps("2026-11-16"));
    expect(sent).toHaveLength(1); // laporan admin beta-co (bukan pengingat)
    expect(sent[0]!.subject).toMatch(/tanpa tenant-admin/);
    const r = await runSubscriptionTick(tickDeps("2026-11-17"));
    expect(r.reminders.sent).toBe(1);
    const reminder = sent.find((m) => /garansi/.test(m.subject))!;
    expect(reminder.to).toEqual([ADMIN_EMAIL]);
    expect(reminder.cc).toEqual([BILLING]);
    expect(reminder.subject).toBe("Masa garansi Acme Corp (Odoo Shared M) berakhir 2026-12-01");
    const again = await runSubscriptionTick(tickDeps("2026-11-20"));
    expect(again.reminders).toEqual({ sent: 0, skipped: 1, failed: 0 });
    expect(sent.filter((m) => /garansi/.test(m.subject))).toHaveLength(1);
  });

  it("warranty → active setelah warranty_until (+ invoice maintenance pertama), H+0, lalu past_due", async () => {
    let r = await runSubscriptionTick(tickDeps("2026-12-01"));
    expect((await sub()).status).toBe("warranty");
    r = await runSubscriptionTick(tickDeps("2026-12-02"));
    expect(r.transitions).toBe(1);
    expect(r.invoicesIssued).toBe(1);
    expect(await sub()).toMatchObject({ status: "active", startsAt: "2026-12-01", endsAt: "2027-01-01", grace: null });
    const m = (await db.select().from(invoices).where(and(eq(invoices.subscriptionId, subId), eq(invoices.kind, "maintenance"))))[0]!;
    expect(m).toMatchObject({ number: "INV/2026/12/0001", amount: "1500000.00", status: "unpaid", periodStart: "2026-12-01", periodEnd: "2027-01-01" });
    // tick ulang hari yang sama: tidak ada invoice ganda
    await runSubscriptionTick(tickDeps("2026-12-02"));
    expect(await db.select().from(invoices).where(eq(invoices.kind, "maintenance"))).toHaveLength(1);

    r = await runSubscriptionTick(tickDeps("2027-01-01"));
    expect(r.reminders.sent).toBe(1);
    expect(reminders().at(-1)!.subject).toBe("Tagihan maintenance Acme Corp (Odoo Shared M) jatuh tempo 2027-01-01");
    expect(reminders().at(-1)!.text).toContain("INV/2026/12/0001");

    r = await runSubscriptionTick(tickDeps("2027-01-02"));
    expect(await sub()).toMatchObject({ status: "past_due", grace: "2027-03-01" });
    expect(r.reminders.sent).toBe(0); // H+0 sudah terkirim (kunci periode sama)
    const audits = await db.select().from(auditLogs).where(eq(auditLogs.action, "subscription.transition"));
    expect(audits.map((x) => (x.metadata as { to: string }).to)).toEqual(["active", "past_due"]);
    expect(audits.every((x) => x.actor === "system:subscription-tick" && x.actorUserId === null)).toBe(true);
  });

  it("past_due → suspended setelah grace: tenant_suspend untuk prod+demo saja (bukan staging), idempoten", async () => {
    let r = await runSubscriptionTick(tickDeps("2027-03-01"));
    expect((await sub()).status).toBe("past_due");
    // H+45 (ends 2027-01-01 + 45 = 2027-02-15) sudah lewat → satu peringatan akhir
    expect(r.reminders.sent).toBe(1);
    expect(reminders().at(-1)!.subject).toMatch(/^Peringatan akhir: tagihan Acme Corp \(Odoo Shared M\)/);
    r = await runSubscriptionTick(tickDeps("2027-03-02"));
    expect(r.suspendJobs).toBe(2);
    expect((await sub()).status).toBe("suspended");
    const jobs = await db.select().from(provisionJobs).where(eq(provisionJobs.type, "tenant_suspend"));
    expect(jobs.map((j) => j.env).sort()).toEqual(["demo", "prod"]);
    expect(jobs.map((j) => j.environmentId).sort()).toEqual([envDemo, envProd].sort());
    expect(jobs.map((j) => j.idempotencyKey).sort()).toEqual(["tenant_suspend:acme-co:demo:tenant", "tenant_suspend:acme-co:prod:tenant"]);
    expect(jobs.every((j) => j.actor === "system:subscription-tick" && j.actorUserId === null && j.clientId === acmeId)).toBe(true);
    expect(jobs.some((j) => j.environmentId === envStaging)).toBe(false);
    expect(r.reminders.sent).toBe(0);
    const enq = await db.select().from(auditLogs).where(eq(auditLogs.action, "job.enqueue.tenant_suspend"));
    expect(enq).toHaveLength(2);
    // tick ulang: tidak ada job/email baru
    const before = reminders().length;
    r = await runSubscriptionTick(tickDeps("2027-03-03"));
    expect(r.transitions).toBe(0);
    expect(await db.select().from(provisionJobs).where(eq(provisionJobs.type, "tenant_suspend"))).toHaveLength(2);
    expect(reminders().length).toBe(before);

    const done = await settle(jobs.map((j) => j.id));
    expect(done.every((j) => j.status === "succeeded")).toBe(true);
    expect((await db.select().from(clients).where(eq(clients.id, acmeId)))[0]!.status).toBe("suspended");
  });

  it("invoice maintenance lunas saat suspended → active, periode +1, invoice berikutnya, tenant_resume (aktor user)", async () => {
    const open = (await db.select().from(invoices).where(and(eq(invoices.kind, "maintenance"), eq(invoices.status, "unpaid"))))[0]!;
    const r = await markInvoicePaid(db, svc(OPS, at("2027-03-05")), {
      invoiceId: open.id,
      paidAt: "2027-03-05",
      paymentReference: "BCA 99",
      proofReference: "email bukti 5 Mar",
    });
    expect(r.ok).toBe(true);
    const jobIds = (r as { jobIds: string[] }).jobIds;
    expect(jobIds).toHaveLength(2);
    expect(await sub()).toMatchObject({ status: "active", startsAt: "2027-01-01", endsAt: "2027-02-01", grace: null, suspendedAt: null });
    const next = await db.select().from(invoices).where(and(eq(invoices.kind, "maintenance"), eq(invoices.status, "unpaid")));
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ number: "INV/2027/03/0001", periodStart: "2027-01-01", periodEnd: "2027-02-01" });
    const resume = await db.select().from(provisionJobs).where(eq(provisionJobs.type, "tenant_resume"));
    expect(resume.map((j) => j.env).sort()).toEqual(["demo", "prod"]);
    expect(resume.every((j) => j.actor === "user:ops-sub" && j.actorUserId === OPS.userId)).toBe(true);
    const paidAudit = (await db.select().from(auditLogs).where(and(eq(auditLogs.action, "invoice.paid"), eq(auditLogs.targetId, open.id))))[0]!;
    expect(paidAudit.metadata).toMatchObject({ transition: { from: "suspended", to: "active" }, next_invoice: "INV/2027/03/0001" });
    expect(JSON.stringify(paidAudit.metadata)).not.toContain("BCA 99");

    const done = await settle(resume.map((j) => j.id));
    expect(done.every((j) => j.status === "succeeded")).toBe(true);
    expect((await db.select().from(clients).where(eq(clients.id, acmeId)))[0]!.status).toBe("active");
    // Pembayaran terlambat: periode baru (s.d. 2027-02-01) juga sudah lewat → tick berikutnya past_due lagi.
    await runSubscriptionTick(tickDeps("2027-03-06"));
    expect(await sub()).toMatchObject({ status: "past_due", grace: "2027-04-01" });
  });

  it("odoo_tenant_config RESULT mode → environments.tenant_check (env job saja)", async () => {
    const [j] = await db
      .insert(provisionJobs)
      .values({
        type: "odoo_tenant_config",
        status: "dispatched",
        clientId: acmeId,
        environmentId: envProd,
        env: "prod",
        payload: { slug: "acme-co", args: { tenant_check: "compat" } },
        actor: "user:super-sub",
        dispatchedAt: new Date(),
        deadlineAt: new Date(Date.now() + 3600_000),
      })
      .returning();
    const now = new Date().toISOString();
    await writeFile(
      path.join(root, "results", `${j!.id}.json`),
      JSON.stringify({ v: 1, job_id: j!.id, ...ok({ db: "acme_co_prod", mode: "compat", changed: "1" }), started_at: now, finished_at: now, duration_ms: 2 }),
    );
    await bridge.collect();
    const envs = await db.select({ kind: environments.kind, tenantCheck: environments.tenantCheck }).from(environments).where(eq(environments.clientId, acmeId));
    expect(Object.fromEntries(envs.map((e) => [e.kind, e.tenantCheck]))).toEqual({ prod: "compat", demo: null, staging: null });
  });

  it("suspend tanpa instance / layanan non-Odoo: transisi tetap, job dilewati + dicatat", async () => {
    const mail = (await db.select().from(plans).where(eq(plans.code, "mail-5")))[0]!;
    const odoo = (await db.select().from(plans).where(eq(plans.code, "odoo-shared-s")))[0]!;
    const mk = async (planId: string) => {
      const r = await createSubscription(db, svc(SUPER), { clientId: betaId, planId });
      const id = (r as { id: string }).id;
      await db
        .update(subscriptions)
        .set({ status: "past_due", currentPeriodStart: dateToTimestamp("2026-01-01"), currentPeriodEnd: dateToTimestamp("2026-02-01"), graceUntil: dateToTimestamp("2026-04-01") })
        .where(eq(subscriptions.id, id));
      return id;
    };
    const mailSub = await mk(mail.id);
    const odooSub = await mk(odoo.id);
    await db.insert(environments).values({ clientId: betaId, kind: "prod", odooInstance: "pool-a", dbName: "beta_co_prod", url: "https://beta-co.erp.bimacreative.tech", routeStatus: "active" });
    const r = await runSubscriptionTick(tickDeps("2027-03-07", { instance: undefined }));
    expect(r.errors).toBe(0);
    expect((await sub(mailSub)).status).toBe("suspended");
    expect((await sub(odooSub)).status).toBe("suspended");
    const t = await db.select().from(auditLogs).where(and(eq(auditLogs.action, "subscription.transition"), eq(auditLogs.clientId, betaId)));
    const skipped = t.map((x) => (x.metadata as { suspend_skipped?: string }).suspend_skipped).filter(Boolean).sort();
    expect(skipped).toEqual(["no_instance", "service_not_odoo"]);
    expect(await db.select().from(provisionJobs).where(and(eq(provisionJobs.clientId, betaId)))).toHaveLength(0);
    // terminate manual dari status apa pun
    expect((await terminateSubscription(db, svc(SUPER), { subscriptionId: mailSub })).ok).toBe(true);
    expect((await sub(mailSub)).status).toBe("terminated");
    expect(await terminateSubscription(db, svc(SUPER), { subscriptionId: mailSub })).toEqual({ ok: false, reason: "billing_status" });
  });

  it("cek tenant-admin: audit harian; email ke billing HANYA saat himpunan berubah (keputusan Lead)", async () => {
    const reports = () => sent.filter((m) => /tanpa tenant-admin/.test(m.subject));
    const auditsBeta = async () =>
      (await db.select().from(auditLogs).where(and(eq(auditLogs.action, "tenant.admin_missing"), eq(auditLogs.clientId, betaId)))).length;
    // Himpunan {beta-co} sejak 2026-11-16 → satu laporan saja sepanjang tick-tick sebelumnya (dulu: satu per hari).
    expect(reports()).toHaveLength(1);
    const a0 = await auditsBeta();
    let r = await runSubscriptionTick(tickDeps("2027-03-08"));
    expect(r).toMatchObject({ tenantsWithoutAdmin: 1, adminCheck: "none" });
    expect(reports()).toHaveLength(1);
    expect(await auditsBeta()).toBe(a0 + 1); // audit tetap harian
    // Tenant baru tanpa admin → himpunan berubah → email (hari yang sama pun).
    const [g] = await db.insert(clients).values({ slug: "gamma-co", name: "Gamma" }).returning();
    r = await runSubscriptionTick(tickDeps("2027-03-08"));
    expect(r).toMatchObject({ tenantsWithoutAdmin: 2, adminCheck: "email" });
    expect(reports()).toHaveLength(2);
    expect(reports().at(-1)!.to).toEqual([BILLING]);
    expect(reports().at(-1)!.text).toContain("- beta-co");
    expect(reports().at(-1)!.text).toContain("- gamma-co");
    expect(reports().at(-1)!.text).not.toContain("acme-co");
    r = await runSubscriptionTick(tickDeps("2027-03-09"));
    expect(r.adminCheck).toBe("none");
    expect(reports()).toHaveLength(2);
    // gamma-co dapat admin → himpunan kembali {beta-co} (berbeda dari notifikasi terakhir) → email.
    await db.insert(users).values({ keycloakSub: "gamma-admin", email: "a@gamma.co.id", role: "client_admin", status: "invited", clientId: g!.id });
    r = await runSubscriptionTick(tickDeps("2027-03-09"));
    expect(r).toMatchObject({ tenantsWithoutAdmin: 1, adminCheck: "email" });
    expect(reports()).toHaveLength(3);
    expect(reports().at(-1)!.text).not.toContain("gamma-co");
    // SMTP nonaktif: audit tetap, tanpa baris notification_log.
    const nLog = (await db.select().from(notificationLog)).length;
    r = await runSubscriptionTick(tickDeps("2027-03-09", { mailer: null }));
    expect(r.adminCheck).toBe("skipped");
    expect((await db.select().from(notificationLog)).length).toBe(nLog);
    expect(await db.select().from(auditLogs).where(and(eq(auditLogs.action, "tenant.admin_missing"), eq(auditLogs.clientId, acmeId)))).toHaveLength(0);
    const log = await db.select().from(notificationLog);
    expect(log.every((l) => l.status === "sent")).toBe(true);
    expect(new Set(log.map((l) => l.key)).size).toBe(log.length);
    expect(JSON.stringify(log)).not.toContain("@");
  });

  it.skipIf(!MP_API)("Mailpit menerima persis email yang dikirim (jumlah, subject, penerima)", async () => {
    const msgs = await waitFor(async () => {
      const m = await mailpit();
      return m.length === sent.length ? m : null;
    });
    expect(msgs.map((m) => m.Subject).sort()).toEqual(sent.map((m) => m.subject).sort());
    const g = msgs.find((m) => /garansi/.test(m.Subject))!;
    expect(g.To.map((x) => x.Address)).toEqual([ADMIN_EMAIL]);
    expect((g.Cc ?? []).map((x) => x.Address)).toEqual([BILLING]);
  });

  it("SMTP gagal → notification_log failed + dicoba ulang (maks. 3), tanpa email ganda", async () => {
    let calls = 0;
    const flaky: Mailer = {
      async send() {
        calls++;
        throw Object.assign(new Error("koneksi ditolak ke admin@x"), { code: "ECONNECTION" });
      },
    };
    await db.insert(users).values({ keycloakSub: "beta-admin", email: "a@beta.co.id", role: "client_admin", status: "active", clientId: betaId });
    // Tidak ada tenant tanpa admin lagi → tidak ada laporan. Periode acme baru (ends 2027-01-20) → H+45 = 2027-03-06 jatuh tempo.
    await db.update(subscriptions).set({ currentPeriodEnd: dateToTimestamp("2027-01-20") }).where(eq(subscriptions.id, subId));
    for (let i = 0; i < 4; i++) await runSubscriptionTick(tickDeps("2027-03-09", { mailer: flaky }));
    const row = (await db.select().from(notificationLog).where(eq(notificationLog.status, "failed")))[0]!;
    expect(row).toMatchObject({ attempts: 3, lastError: "ECONNECTION", kind: "due_h45" });
    expect(calls).toBe(3);
    // Himpunan tenant tanpa admin kini kosong → penanda `none` tanpa email (recipient_count 0).
    const mark = (await db.select().from(notificationLog).where(eq(notificationLog.key, "admin_check:2027-03-09:none")))[0]!;
    expect(mark).toMatchObject({ kind: "admin_check", status: "sent", recipientCount: 0 });
  });

  it("worker: schedule 00:15 Asia/Jakarta; TICK_NOW hanya staging", async () => {
    await registerSubscriptionTick(workerBoss, { db, env: { INFRA_JOBS_INSTANCE: "prod", SMTP_PORT: 587, SMTP_TLS: "required", SMTP_FROM: "noreply@bimacreative.tech", BILLING_EMAIL: BILLING }, logger: quiet, mailer: null });
    const s = await workerBoss.getSchedules(QUEUE_SUBSCRIPTION_TICK);
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ cron: "15 0 * * *", timezone: "Asia/Jakarta" });
    const next = workerBoss.previewSchedule("15 0 * * *", { tz: "Asia/Jakarta", from: new Date("2026-10-03T00:00:00Z"), count: 1 });
    expect(next[0]!.toISOString()).toBe("2026-10-03T17:15:00.000Z");

    const base = { SMTP_PORT: 587, SMTP_TLS: "required" as const, SMTP_FROM: "noreply@bimacreative.tech", BILLING_EMAIL: BILLING };
    const staging = createTickRunner({ db, boss: workerBoss, env: { ...base, INFRA_JOBS_INSTANCE: "staging", TICK_NOW: "2027-03-10" }, logger: quiet, mailer: null });
    expect((await staging(new Date("2026-10-03T03:00:00Z"))).today).toBe("2027-03-10");
    const prod = createTickRunner({ db, boss: workerBoss, env: { ...base, INFRA_JOBS_INSTANCE: "prod", TICK_NOW: "2027-03-10" }, logger: quiet, mailer: null });
    expect((await prod(new Date("2026-10-03T03:00:00Z"))).today).toBe("2026-10-03");
  });

  it("override harga langganan: invoice maintenance otomatis memakai override → harga plan → dilewati + audit price_missing", async () => {
    const shared = (await db.select().from(plans).where(eq(plans.code, "odoo-shared-s")))[0]!;
    expect(shared.priceAmount).toBeNull();
    const [d] = await db.insert(clients).values({ slug: "delta-co", name: "Delta" }).returning();
    const deltaId = d!.id;
    const created = await createSubscription(db, svc(SUPER), { clientId: deltaId, planId: shared.id, priceAmount: "2750000.50", priceCurrency: "IDR" });
    expect(created.ok).toBe(true);
    const dsub = (created as { id: string }).id;
    expect(await sub(dsub)).toMatchObject({ status: "implementation", priceAmount: "2750000.50", priceCurrency: "IDR" });
    // ops tidak boleh; superadmin ubah override; langganan terminated ditolak (diuji di bawah)
    expect(await setSubscriptionPrice(db, svc(OPS), { subscriptionId: dsub, priceAmount: "1", priceCurrency: "IDR" })).toEqual({ ok: false, reason: "forbidden" });
    expect((await setSubscriptionPrice(db, svc(SUPER), { subscriptionId: dsub, priceAmount: "3000000", priceCurrency: "IDR" })).ok).toBe(true);
    const pa = (await db.select().from(auditLogs).where(and(eq(auditLogs.action, "subscription.price"), eq(auditLogs.targetId, dsub))))!;
    expect(pa.map((x) => x.result).sort()).toEqual(["rejected", "success"]);
    expect(pa.find((x) => x.result === "success")!.metadata).toMatchObject({
      from: { price_amount: "2750000.50", price_currency: "IDR" },
      to: { price_amount: "3000000", price_currency: "IDR" },
      plan_price: null,
    });

    expect((await goLiveSubscription(db, svc(SUPER, at("2027-04-02")), { subscriptionId: dsub, goLiveAt: "2027-04-01" })).ok).toBe(true);
    await runSubscriptionTick(tickDeps("2027-06-02", { mailer: null }));
    expect((await sub(dsub)).status).toBe("active");
    const inv1 = (await db.select().from(invoices).where(eq(invoices.subscriptionId, dsub)))[0]!;
    expect(inv1).toMatchObject({ kind: "maintenance", amount: "3000000.00", currency: "IDR", periodStart: "2027-06-01", periodEnd: "2027-07-01" });
    const t1 = (await db.select().from(auditLogs).where(and(eq(auditLogs.action, "subscription.transition"), eq(auditLogs.targetId, dsub))))[0]!;
    expect(t1.metadata).toMatchObject({ to: "active", price_source: "subscription", invoice: inv1.number });

    // Override dihapus + harga plan NULL → lunas: periode diperpanjang, invoice berikutnya DILEWATI (price_missing).
    expect((await setSubscriptionPrice(db, svc(SUPER), { subscriptionId: dsub, priceAmount: null, priceCurrency: "IDR" })).ok).toBe(true);
    expect(await sub(dsub)).toMatchObject({ priceAmount: null, priceCurrency: null });
    const paid = await markInvoicePaid(db, svc(OPS, at("2027-06-05")), { invoiceId: inv1.id, paidAt: "2027-06-05", paymentReference: "BCA 9", proofReference: "mutasi" });
    expect(paid.ok).toBe(true);
    expect(await db.select().from(invoices).where(eq(invoices.subscriptionId, dsub))).toHaveLength(1);
    const pd = (await db.select().from(auditLogs).where(and(eq(auditLogs.action, "invoice.paid"), eq(auditLogs.targetId, inv1.id))))[0]!;
    expect(pd.metadata).toMatchObject({ next_invoice: "price_missing" });

    // Harga plan diisi kemudian → dipakai bila tanpa override (tick warranty → active pada langganan baru).
    await db.update(plans).set({ priceAmount: "900000" }).where(eq(plans.id, shared.id));
    const [e] = await db.insert(clients).values({ slug: "eps-co", name: "Eps" }).returning();
    const esub = ((await createSubscription(db, svc(SUPER), { clientId: e!.id, planId: shared.id })) as { id: string }).id;
    await goLiveSubscription(db, svc(SUPER, at("2027-04-02")), { subscriptionId: esub, goLiveAt: "2027-04-01" });
    await runSubscriptionTick(tickDeps("2027-06-02", { mailer: null }));
    expect((await db.select().from(invoices).where(eq(invoices.subscriptionId, esub)))[0]).toMatchObject({ amount: "900000.00", currency: "IDR" });
    await db.update(plans).set({ priceAmount: null }).where(eq(plans.id, shared.id));

    expect((await terminateSubscription(db, svc(SUPER), { subscriptionId: dsub })).ok).toBe(true);
    expect(await setSubscriptionPrice(db, svc(SUPER), { subscriptionId: dsub, priceAmount: "1", priceCurrency: "IDR" })).toEqual({ ok: false, reason: "billing_status" });
  });

  it("QA N2: aktor nonaktif (sesi masih hidup) → setiap aksi billing ditolak + diaudit", async () => {
    const [t] = await db.insert(clients).values({ slug: "kappa-co", name: "Kappa" }).returning();
    const inv = await issueInvoice(db, svc(SUPER), { clientId: t!.id, kind: "implementation", amount: "5000000", dueAt: "2027-12-31" });
    expect(inv.ok).toBe(true);
    const invId = (inv as { id: string }).id;
    await db.update(users).set({ status: "disabled" }).where(eq(users.id, OPS.userId!));
    expect(await markInvoicePaid(db, svc(OPS), { invoiceId: invId, paidAt: "2026-10-01", paymentReference: "BCA", proofReference: "mutasi" })).toEqual({
      ok: false,
      reason: "forbidden",
    });
    await db.update(users).set({ status: "disabled" }).where(eq(users.id, SUPER.userId!));
    expect(await voidInvoice(db, svc(SUPER), { invoiceId: invId, reason: "uji nonaktif" })).toEqual({ ok: false, reason: "forbidden" });
    expect(await issueInvoice(db, svc(SUPER), { clientId: t!.id, kind: "implementation", amount: "1", dueAt: "2027-12-31" })).toEqual({ ok: false, reason: "forbidden" });
    await db.update(users).set({ status: "active" }).where(inArray(users.id, [OPS.userId!, SUPER.userId!]));
    expect((await db.select().from(invoices).where(eq(invoices.id, invId)))[0]!.status).toBe("unpaid");
    const rej = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.result, "rejected"), inArray(auditLogs.action, ["invoice.paid", "invoice.void"]), eq(auditLogs.targetId, invId)));
    expect(rej.map((a) => [a.action, (a.metadata as { reason?: string }).reason]).sort()).toEqual([
      ["invoice.paid", "forbidden"],
      ["invoice.void", "forbidden"],
    ]);
    const rejIssue = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.result, "rejected"), eq(auditLogs.action, "invoice.issue"), eq(auditLogs.clientId, t!.id)));
    expect(rejIssue).toHaveLength(1);
  });

  it("QA N4: invoice nol dan override harga nol ditolak (layanan + CHECK DB)", async () => {
    const [t] = await db.insert(clients).values({ slug: "lambda-co", name: "Lambda" }).returning();
    expect(await issueInvoice(db, svc(SUPER), { clientId: t!.id, kind: "implementation", amount: "0", dueAt: "2027-12-31" })).toEqual({ ok: false, reason: "invalid" });
    const plan = (await db.select().from(plans).where(eq(plans.code, "web-profile")))[0]!;
    expect(await createSubscription(db, svc(SUPER), { clientId: t!.id, planId: plan.id, priceAmount: "0.00", priceCurrency: "IDR" })).toEqual({ ok: false, reason: "invalid" });
    const s = await createSubscription(db, svc(SUPER), { clientId: t!.id, planId: plan.id });
    const sid = (s as { id: string }).id;
    expect(await setSubscriptionPrice(db, svc(SUPER), { subscriptionId: sid, priceAmount: "0", priceCurrency: "IDR" })).toEqual({ ok: false, reason: "invalid" });
    await expect(db.update(subscriptions).set({ priceAmount: "0", priceCurrency: "IDR" }).where(eq(subscriptions.id, sid))).rejects.toThrow();
    await expect(
      db.insert(invoices).values({ number: "INV/2099/01/0001", clientId: t!.id, amount: "0", dueAt: new Date("2099-01-31T00:00:00Z") }),
    ).rejects.toThrow();
  });

  it("QA N8: suspend otomatis & resume saat lunas memakai cek kebalikan aktif (ditunda + audit); tenant terminated dilewati", async () => {
    const odoo = (await db.select().from(plans).where(eq(plans.code, "odoo-shared-s")))[0]!;
    const [t] = await db.insert(clients).values({ slug: "theta-co", name: "Theta" }).returning();
    const tid = t!.id;
    await db.insert(environments).values({
      clientId: tid,
      kind: "prod",
      odooInstance: "pool-a",
      dbName: "theta_co_prod",
      url: "https://theta-co.erp.bimacreative.tech",
      host: "theta-co.erp.bimacreative.tech",
      routeStatus: "active",
    });
    const sid = ((await createSubscription(db, svc(SUPER), { clientId: tid, planId: odoo.id })) as { id: string }).id;
    await db
      .update(subscriptions)
      .set({ status: "past_due", currentPeriodStart: dateToTimestamp("2027-06-01"), currentPeriodEnd: dateToTimestamp("2027-07-01"), graceUntil: dateToTimestamp("2027-09-01") })
      .where(eq(subscriptions.id, sid));
    // Job tenant_resume (kebalikan) masih aktif → transisi suspended ditunda, dicoba tick berikutnya.
    const [resume] = await db
      .insert(provisionJobs)
      .values({ type: "tenant_resume", status: "queued", clientId: tid, env: "prod", actor: "user:super-sub", payload: { slug: "theta-co", args: {} } })
      .returning();
    let r = await runSubscriptionTick(tickDeps("2027-09-05", { mailer: null }));
    expect(r.deferred).toBeGreaterThanOrEqual(1);
    expect((await sub(sid)).status).toBe("past_due");
    const deferred = await db.select().from(auditLogs).where(and(eq(auditLogs.action, "subscription.tick_deferred"), eq(auditLogs.targetId, sid)));
    expect(deferred[0]!.metadata).toMatchObject({ reason: "state_busy", opposite_job_id: resume!.id });
    expect(await db.select().from(provisionJobs).where(and(eq(provisionJobs.clientId, tid), eq(provisionJobs.type, "tenant_suspend")))).toHaveLength(0);
    // Job kebalikan selesai → tick berikutnya menyuspend.
    await db.update(provisionJobs).set({ status: "succeeded" }).where(eq(provisionJobs.id, resume!.id));
    r = await runSubscriptionTick(tickDeps("2027-09-06", { mailer: null }));
    expect((await sub(sid)).status).toBe("suspended");
    const susp = await db.select().from(provisionJobs).where(and(eq(provisionJobs.clientId, tid), eq(provisionJobs.type, "tenant_suspend")));
    expect(susp).toHaveLength(1);
    // Lunas saat tenant_suspend masih aktif → state_busy (tanpa perubahan); setelah selesai → active + tenant_resume.
    const inv = await issueInvoice(db, svc(SUPER, at("2027-09-06")), { clientId: tid, subscriptionId: sid, kind: "maintenance", amount: "900000", dueAt: "2027-09-20" });
    const invId = (inv as { id: string }).id;
    const pay = () => markInvoicePaid(db, svc(OPS, at("2027-09-07")), { invoiceId: invId, paidAt: "2027-09-07", paymentReference: "BCA 7", proofReference: "mutasi" });
    expect(await pay()).toMatchObject({ ok: false, reason: "state_busy", detail: susp[0]!.id });
    expect((await sub(sid)).status).toBe("suspended");
    expect((await db.select().from(invoices).where(eq(invoices.id, invId)))[0]!.status).toBe("unpaid");
    await db.update(provisionJobs).set({ status: "succeeded" }).where(eq(provisionJobs.id, susp[0]!.id));
    const paid = await pay();
    expect(paid).toMatchObject({ ok: true });
    expect((paid as { jobIds: string[] }).jobIds).toHaveLength(1);
    expect((await sub(sid)).status).toBe("active");

    // Tenant terminated: langganan tidak pernah ditransisikan tick.
    const [term] = await db.insert(clients).values({ slug: "iota-co", name: "Iota" }).returning();
    const isub = ((await createSubscription(db, svc(SUPER), { clientId: term!.id, planId: odoo.id })) as { id: string }).id;
    await db.update(subscriptions).set({ status: "warranty", goLiveAt: "2027-01-01", warrantyUntil: "2027-03-01" }).where(eq(subscriptions.id, isub));
    await db.update(clients).set({ status: "terminated" }).where(eq(clients.id, term!.id));
    await runSubscriptionTick(tickDeps("2027-09-08", { mailer: null }));
    expect((await sub(isub)).status).toBe("warranty");
    expect(await db.select().from(invoices).where(eq(invoices.subscriptionId, isub))).toHaveLength(0);
  });
});
