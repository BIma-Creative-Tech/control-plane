/**
 * Integrasi registrasi BCTOne: start (batas) → OTP (worker, hash) → verifikasi (salah/kunci) → isian → submit
 * (Free → provisioning rantai onboarding + consent hash-chain; Bisnis → review; kapasitas → waitlist) → approve owner.
 * Postgres SEKALI PAKAI (TEST_DATABASE_URL; skema di-DROP).
 */
import { asc, eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  activeBctoneTenants,
  loadRegistration,
  provisionRegistration,
  registrationProgress,
  rejectRegistration,
  saveStep,
  settleRegistrations,
  startRegistration,
  submitRegistration,
  verifyOtp,
} from "@/bctone/registration";
import { createDb, type Db } from "@/db/client";
import { ensureBctonePlans, ensureInitialPlans } from "@/db/plans";
import { ensurePlatformTenant } from "@/db/platform";
import { aiConsentLog, auditLogs, bctoneRegistrations, clients, provisionJobs, subscriptions } from "@/db/schema";
import type { Actor, SendFn } from "@/jobs/service";
import { BRIDGE_JOB_TYPES } from "@/lib/job-contract";
import { otpHash } from "@/lib/bctone-register";
import type { Mailer, MailMessage } from "@/billing/mailer";
import { sendRegistrationOtp } from "@/worker/bctone-otp";
import { notifyRegistrations } from "@/bctone/notify";
import { portalReportPayment } from "@/billing/portal-payment";
import { createSubscription, setClientBillingExempt, type BillingServiceInput } from "@/billing/service";
import { runSubscriptionTick } from "@/billing/tick";
import { setRegistrationBillingExempt } from "@/bctone/registration";
import { invoices, notificationLog, plans, users } from "@/db/schema";

const URL_ = process.env.TEST_DATABASE_URL;
const META = { ip: "203.0.113.50", requestId: "req-reg" };

describe.skipIf(!URL_)("BCTOne registrasi self-serve", () => {
  let db: Db;
  let pool: { end: () => Promise<void> };
  const sent: MailMessage[] = [];
  const mailer: Mailer = { send: async (m) => void sent.push(m) };
  const send: SendFn = async () => "boss-id";
  const ctx = (capacity = 15) => ({ instance: "staging" as const, allowedTypes: [...BRIDGE_JOB_TYPES], capacity, send, meta: META });
  const lastCode = () => /: ([0-9]{6})$/.exec(sent.at(-1)!.subject)![1]!;

  const fill = async (id: string, tier: "free" | "umkm" | "bisnis", extra: string | null = null, modules = ["pos", "inventory"]) => {
    expect(await saveStep(db, id, { industry: "fnb", outlets: 1, modules, extraNeeds: extra, tier, aiConsent: "deny" })).toBe(true);
  };
  const startVerified = async (slug: string, email = `${slug}@example.co.id`, ip = META.ip) => {
    const s = await startRegistration(db, { email, ownerName: "Budi", businessName: `Usaha ${slug}`, slug, meta: { ...META, ip } });
    expect(s.ok).toBe(true);
    const id = (s as { id: string }).id;
    expect(await sendRegistrationOtp(db, mailer, id)).toBe("sent");
    expect(await verifyOtp(db, id, lastCode(), META)).toEqual({ ok: true });
    return id;
  };

  beforeAll(async () => {
    ({ db, pool } = createDb(URL_!, { max: 4, applicationName: "cp-int-register" }));
    await db.execute(sql`DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA IF EXISTS pgboss CASCADE; CREATE SCHEMA public;`);
    await migrate(db, { migrationsFolder: "./drizzle" });
    await ensurePlatformTenant(db);
    await ensureInitialPlans(db);
    await ensureBctonePlans(db);
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
  });

  it("OTP: hanya hash disimpan; salah 5x terkunci; kedaluwarsa ditolak", async () => {
    const s = await startRegistration(db, { email: "otp@example.co.id", ownerName: "Ani", businessName: "Toko Ani", slug: "toko-ani", meta: META });
    const id = (s as { id: string }).id;
    expect(await sendRegistrationOtp(db, null, id)).toBe("no_mailer");
    expect(await sendRegistrationOtp(db, mailer, id)).toBe("sent");
    const code = lastCode();
    expect(sent.at(-1)!.to).toEqual(["otp@example.co.id"]);
    const r = (await loadRegistration(db, id))!;
    expect(r.otpHash).toBe(otpHash(r.otpSalt!, code));
    expect(JSON.stringify(r)).not.toContain(`"${code}"`);
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 4; i++) expect(await verifyOtp(db, id, wrong, META)).toEqual({ ok: false, reason: "wrong" });
    expect(await verifyOtp(db, id, wrong, META)).toEqual({ ok: false, reason: "locked" });
    expect(await verifyOtp(db, id, code, META)).toEqual({ ok: false, reason: "locked" });
    // kirim ulang → percobaan reset; kedaluwarsa ditolak
    expect(await sendRegistrationOtp(db, mailer, id)).toBe("sent");
    expect(await verifyOtp(db, id, lastCode(), META, new Date(Date.now() + 11 * 60_000))).toEqual({ ok: false, reason: "expired" });
    expect(await verifyOtp(db, id, lastCode(), META)).toEqual({ ok: true });
    expect(await sendRegistrationOtp(db, mailer, id)).toBe("skipped"); // sudah verified
  });

  it("batas: email 3/jam, IP 10/jam", async () => {
    for (let i = 0; i < 2; i++) {
      expect((await startRegistration(db, { email: "spam@example.co.id", ownerName: "X", businessName: "Spam", slug: `spam-${i}`, meta: { ...META, ip: "198.51.100.1" } })).ok).toBe(true);
    }
    expect((await startRegistration(db, { email: "spam@example.co.id", ownerName: "X", businessName: "Spam", slug: "spam-2", meta: { ...META, ip: "198.51.100.1" } })).ok).toBe(true);
    expect(await startRegistration(db, { email: "spam@example.co.id", ownerName: "X", businessName: "Spam", slug: "spam-3", meta: { ...META, ip: "198.51.100.1" } })).toEqual({ ok: false, reason: "rate_limited" });
    for (let i = 0; i < 7; i++) await startRegistration(db, { email: `ip${i}@example.co.id`, ownerName: "X", businessName: "Ip", slug: `ip-${i}`, meta: { ...META, ip: "198.51.100.1" } });
    expect(await startRegistration(db, { email: "ip9@example.co.id", ownerName: "X", businessName: "Ip", slug: "ip-9", meta: { ...META, ip: "198.51.100.1" } })).toEqual({ ok: false, reason: "rate_limited" });
  });

  it("Free → provisioning: tenant + langganan self-serve + rantai onboarding dengan bctone_tenant_config pack fnb + consent", async () => {
    const id = await startVerified("kopi-senja");
    expect(await submitRegistration(db, id, ctx())).toEqual({ ok: false, reason: "incomplete" });
    await fill(id, "free");
    const out = await submitRegistration(db, id, ctx());
    expect(out).toMatchObject({ ok: true, status: "provisioning" });
    const r = (await loadRegistration(db, id))!;
    expect(r.status).toBe("provisioning");
    const c = (await db.select().from(clients).where(eq(clients.slug, "kopi-senja")))[0]!;
    expect(r.clientId).toBe(c.id);
    expect(c.aiConsent).toBe("deny");
    const sub = (await db.select().from(subscriptions).where(eq(subscriptions.clientId, c.id)))[0]!;
    expect([sub.lifecycle, sub.status]).toEqual(["self_serve", "active"]);
    const all = await db.select().from(provisionJobs).where(eq(provisionJobs.chainId, r.chainId!)).orderBy(asc(provisionJobs.createdAt));
    // urutkan mengikuti after_job_id (rantai linear)
    const jobs: typeof all = [];
    let prev: string | null = null;
    while (jobs.length < all.length) {
      const next = all.find((j) => j.afterJobId === prev);
      if (!next) break;
      jobs.push(next);
      prev = next.id;
    }
    expect(jobs).toHaveLength(all.length);
    const types = jobs.map((j) => j.type);
    expect(types).toContain("bctone_tenant_config");
    expect(types.indexOf("bctone_tenant_config")).toBe(types.indexOf("odoo_db_provision") + 1);
    const cfg = jobs.find((j) => j.type === "bctone_tenant_config")!;
    expect((cfg.payload as { args: { pack?: string; plan: string } }).args).toMatchObject({ plan: "bctone-free", pack: "fnb" });
    expect(jobs.find((j) => j.type === "kc_user_ensure")!.payload).toMatchObject({ args: { email: "kopi-senja@example.co.id" } });
    expect((await db.select().from(aiConsentLog).where(eq(aiConsentLog.clientId, c.id))).map((x) => x.consent)).toEqual(["deny"]);
    // slug kini terpakai untuk registrasi baru
    expect(await startRegistration(db, { email: "lain@example.co.id", ownerName: "L", businessName: "L", slug: "kopi-senja", meta: { ...META, ip: "192.0.2.9" } })).toEqual({ ok: false, reason: "slug_taken" });
    // submit ulang tidak membuat apa pun
    expect(await submitRegistration(db, id, ctx())).toEqual({ ok: false, reason: "state" });
    const audit = await db.select({ a: auditLogs.action, actor: auditLogs.actor, md: auditLogs.metadata }).from(auditLogs).where(eq(auditLogs.targetId, id));
    expect(audit.map((x) => x.a)).toEqual(expect.arrayContaining(["registration.start", "registration.verify", "registration.submit", "registration.provision"]));
    expect(JSON.stringify(audit)).not.toContain("kopi-senja@example.co.id");
  });

  it("settle: provisioning → done hanya bila langkah TERBARU per tipe semuanya sukses (ulangi = rantai baru)", async () => {
    const r = (await db.select().from(bctoneRegistrations).where(eq(bctoneRegistrations.slug, "kopi-senja")))[0]!;
    expect(await settleRegistrations(db)).toBe(0);
    await db.update(provisionJobs).set({ status: "succeeded" }).where(eq(provisionJobs.clientId, r.clientId!));
    const last = (await db.select().from(provisionJobs).where(eq(provisionJobs.clientId, r.clientId!)).orderBy(asc(provisionJobs.createdAt))).at(-1)!;
    await db.update(provisionJobs).set({ status: "failed" }).where(eq(provisionJobs.id, last.id));
    expect(await settleRegistrations(db)).toBe(0);
    expect((await registrationProgress(db, r)).failed).toBe(1);
    // "ulangi" → job baru tipe sama sukses
    await db.insert(provisionJobs).values({ ...last, id: undefined, status: "succeeded", idempotencyKey: null, afterJobId: null, createdAt: new Date(Date.now() + 1000) } as typeof provisionJobs.$inferInsert);
    expect(await registrationProgress(db, r)).toMatchObject({ failed: 0, active: 0 });
    expect(await settleRegistrations(db)).toBe(1);
    expect((await loadRegistration(db, r.id))!.status).toBe("done");
  });

  it("paket di bawah minimum ditolak (incomplete); Bisnis/kebutuhan lain → review; owner approve → provisioning", async () => {
    const id = await startVerified("resto-a", "resto@example.co.id", "192.0.2.10");
    await fill(id, "free", null, ["pos", "restaurant"]); // restaurant = UMKM
    expect(await submitRegistration(db, id, ctx())).toEqual({ ok: false, reason: "incomplete" });
    await fill(id, "umkm", "integrasi ojol", ["pos", "restaurant"]);
    expect(await submitRegistration(db, id, ctx())).toEqual({ ok: true, status: "review" });
    expect((await db.select().from(clients).where(eq(clients.slug, "resto-a"))).length).toBe(0);
    const owner: Actor = { sub: "owner-sub", userId: null, roles: ["superadmin"] };
    const p = await provisionRegistration(db, id, ctx(), owner);
    expect(p.ok).toBe(true);
    expect((await loadRegistration(db, id))!.status).toBe("provisioning");
  });

  it("kapasitas penuh → waitlist; tolak oleh owner", async () => {
    expect(await activeBctoneTenants(db)).toBe(2);
    const id = await startVerified("toko-b", "tokob@example.co.id", "192.0.2.11");
    await fill(id, "free");
    expect(await submitRegistration(db, id, ctx(2))).toEqual({ ok: true, status: "waitlist" });
    expect(await rejectRegistration(db, id, "kapasitas penuh bulan ini", META)).toBe(true);
    expect((await loadRegistration(db, id))!.status).toBe("rejected");
    expect(await rejectRegistration(db, id, "lagi", META)).toBe(false);
  });

  it("instance tanpa tipe bctone → provisioning gagal tercatat (failed), bukan tenant setengah jadi", async () => {
    const id = await startVerified("toko-c", "tokoc@example.co.id", "192.0.2.12");
    await fill(id, "free");
    const out = await submitRegistration(db, id, { ...ctx(), allowedTypes: [] });
    expect(out).toMatchObject({ ok: false, reason: "provision_failed" });
    expect((await loadRegistration(db, id))!.status).toBe("failed");
    expect((await db.select().from(clients).where(eq(clients.slug, "toko-c"))).length).toBe(0);
    expect((await db.select().from(bctoneRegistrations).where(eq(bctoneRegistrations.status, "failed"))).length).toBe(1);
  });

  it("notifikasi: owner untuk review/waitlist, sambutan saat done, tolak ke pendaftar — sekali per key", async () => {
    const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
    sent.length = 0;
    const d = { db, mailer, logger: quiet, ownerEmail: "billing@bimacreative.tech", adminUrl: "https://cp.example" };
    // registrasi review baru (resto-a sudah disetujui → bukan review lagi)
    const rid = await startVerified("bakery-z", "bakery@example.co.id", "192.0.2.13");
    await fill(rid, "bisnis", null, ["pos", "accounting"]);
    expect(await submitRegistration(db, rid, ctx())).toEqual({ ok: true, status: "review" });
    sent.length = 0; // abaikan email OTP bakery-z
    const n1 = await notifyRegistrations(d);
    const subjects = sent.map((m) => `${m.to[0]}|${m.subject}`).sort();
    expect(subjects).toEqual([
      "billing@bimacreative.tech|[BCTOne] Pendaftaran menunggu review: Usaha bakery-z",
      "kopi-senja@example.co.id|ERP BCTOne Anda siap",
      "tokob@example.co.id|Pendaftaran BCTOne Anda",
    ]);
    expect(n1).toBe(3);
    expect(sent.find((m) => m.to[0] === "kopi-senja@example.co.id")!.text).toContain("https://kopi-senja.staging.bimacreative.tech");
    expect(await notifyRegistrations(d)).toBe(0); // dedupe
    expect((await db.select().from(notificationLog)).every((x) => x.status === "sent")).toBe(true);
  });

  it("Console › Tagihan: tenant-admin lapor bayar → awaiting_confirmation; PPh 23 wajib bila memotong; tenant lain not_found", async () => {
    const c = (await db.select().from(clients).where(eq(clients.slug, "kopi-senja")))[0]!;
    const other = (await db.select().from(clients).where(eq(clients.slug, "resto-a")))[0]!;
    const [sa] = await db.insert(users).values({ keycloakSub: "sa-bill", role: "superadmin" }).returning();
    const SA = { sub: "sa-bill", userId: sa!.id, roles: ["superadmin" as const] };
    const svc: BillingServiceInput = { actor: SA, meta: META, instance: "staging", allowedTypes: [...BRIDGE_JOB_TYPES], send };
    // ganti ke UMKM berbayar: akhiri langganan Free lalu buat UMKM (invoice pertama berpajak)
    await db.update(subscriptions).set({ status: "terminated" }).where(eq(subscriptions.clientId, c.id));
    await db.update(clients).set({ withholdsPph23: true }).where(eq(clients.id, c.id));
    const umkm = (await db.select().from(plans).where(eq(plans.code, "bctone-umkm")))[0]!;
    expect((await createSubscription(db, svc, { clientId: c.id, planId: umkm.id })).ok).toBe(true);
    const inv = (await db.select().from(invoices).where(eq(invoices.clientId, c.id)))[0]!;
    expect([inv.amount, inv.ppnAmount, inv.pph23Amount, inv.totalAmount]).toEqual(["199000.00", "21890.00", "3980.00", "220890.00"]);
    const [adm] = await db.insert(users).values({ keycloakSub: "adm-ks", role: "client_admin", clientId: c.id, status: "active" }).returning();
    const [usr] = await db.insert(users).values({ keycloakSub: "usr-ks", role: "client_user", clientId: c.id, status: "active" }).returning();
    const A = { sub: "adm-ks", userId: adm!.id, roles: ["client_admin" as const] };
    const form = { invoiceId: inv.id, paid_on: "2026-11-01", bank_reference: "BCA 0111 INV" };
    const now = new Date("2026-11-02T03:00:00Z");
    expect(await portalReportPayment(db, { clientId: c.id, userId: usr!.id, actor: A, meta: META, form, now })).toEqual({ ok: false, reason: "forbidden" });
    expect(await portalReportPayment(db, { clientId: other.id, userId: adm!.id, actor: A, meta: META, form, now })).toEqual({ ok: false, reason: "forbidden" });
    expect(await portalReportPayment(db, { clientId: c.id, userId: adm!.id, actor: A, meta: META, form: { ...form, paid_on: "2026-11-05" }, now })).toEqual({ ok: false, reason: "future_date" });
    expect(await portalReportPayment(db, { clientId: c.id, userId: adm!.id, actor: A, meta: META, form, now })).toEqual({ ok: false, reason: "pph23_required" });
    expect(await portalReportPayment(db, { clientId: c.id, userId: adm!.id, actor: A, meta: META, form: { ...form, pph23_reference: "BP-2026-0001" }, now })).toEqual({ ok: true });
    const after = (await db.select().from(invoices).where(eq(invoices.id, inv.id)))[0]!;
    expect(after.status).toBe("awaiting_confirmation");
    expect(after.proofReference).toBe("transfer 2026-11-01: BCA 0111 INV | bukti potong PPh 23: BP-2026-0001");
    expect(await portalReportPayment(db, { clientId: c.id, userId: adm!.id, actor: A, meta: META, form: { ...form, pph23_reference: "x12" }, now })).toEqual({ ok: false, reason: "invoice_state" });
    // invoice tenant lain dari admin ini → not_found
    const [adm2] = await db.insert(users).values({ keycloakSub: "adm-ra", role: "client_admin", clientId: other.id, status: "active" }).returning();
    expect(await portalReportPayment(db, { clientId: other.id, userId: adm2!.id, actor: { ...A, sub: "adm-ra", userId: adm2!.id }, meta: META, form, now })).toEqual({ ok: false, reason: "not_found" });
  });

  it("bebas tagihan: registrasi Bisnis ditandai owner → approve tanpa invoice; tick bertahun-tahun tetap active; toggle klien lama me-void invoice terbuka", async () => {
    const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
    const id = await startVerified("bct-int", "owner@bct.example", "192.0.2.20");
    await fill(id, "bisnis", null, ["pos", "accounting"]);
    expect(await submitRegistration(db, id, ctx())).toEqual({ ok: true, status: "review" });
    expect(await setRegistrationBillingExempt(db, id, true, META)).toBe(true);
    const owner: Actor = { sub: "owner-sub", userId: null, roles: ["superadmin"] };
    const p = await provisionRegistration(db, id, ctx(), owner);
    expect(p.ok).toBe(true);
    expect(await setRegistrationBillingExempt(db, id, false, META)).toBe(false); // sudah bukan review
    const c = (await db.select().from(clients).where(eq(clients.slug, "bct-int")))[0]!;
    expect(c.billingExempt).toBe(true);
    const sub = (await db.select().from(subscriptions).where(eq(subscriptions.clientId, c.id)))[0]!;
    expect(sub.status).toBe("active");
    expect(await db.select().from(invoices).where(eq(invoices.clientId, c.id))).toHaveLength(0);
    const tick = (today: string) =>
      runSubscriptionTick({ db, send, instance: "staging", allowedTypes: [...BRIDGE_JOB_TYPES], logger: quiet, mailer, billingEmail: "billing@bimacreative.tech", now: new Date(`${today}T03:00:00Z`), today });
    await tick("2029-06-15");
    const after = (await db.select().from(subscriptions).where(eq(subscriptions.id, sub.id)))[0]!;
    expect(after.status).toBe("active");
    expect(after.currentPeriodEnd!.getTime()).toBeGreaterThan(new Date("2029-06-15T00:00:00Z").getTime());
    expect(await db.select().from(invoices).where(eq(invoices.clientId, c.id))).toHaveLength(0);
    expect((await db.select().from(notificationLog).where(eq(notificationLog.clientId, c.id))).filter((n) => n.kind !== "bctone_registration_welcome")).toHaveLength(0);

    // klien berbayar lama (kopi-senja: invoice UMKM awaiting_confirmation) → bebas tagihan: invoice terbuka di-void
    const ks = (await db.select().from(clients).where(eq(clients.slug, "kopi-senja")))[0]!;
    const [sa] = await db.insert(users).values({ keycloakSub: "sa-exempt", role: "superadmin" }).returning();
    const svc: BillingServiceInput = { actor: { sub: "sa-exempt", userId: sa!.id, roles: ["superadmin"] }, meta: META, instance: "staging", allowedTypes: [...BRIDGE_JOB_TYPES], send };
    expect(await setClientBillingExempt(db, svc, { clientId: ks.id, exempt: true })).toMatchObject({ ok: true });
    const open = (await db.select().from(invoices).where(eq(invoices.clientId, ks.id))).filter((i) => i.status !== "void");
    expect(open).toHaveLength(0);
    const plat = (await db.select().from(clients).where(eq(clients.isPlatform, true)))[0]!;
    expect(await setClientBillingExempt(db, svc, { clientId: plat.id, exempt: true })).toMatchObject({ ok: false, reason: "invalid" });
  });
});
