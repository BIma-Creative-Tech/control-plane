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
  rejectRegistration,
  saveStep,
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
});
