/**
 * Integrasi D-1 + ADR 0019: form CP mengelola paket BCTOne (harga, kuota, aktif), pajak klien (PPh 23), dan langganan
 * self-serve (langsung aktif + invoice pertama berpajak). Postgres SEKALI PAKAI (TEST_DATABASE_URL; skema di-DROP).
 */
import { and, eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSubscription, markInvoicePaid, setClientWithholding, updatePlan, type BillingServiceInput } from "@/billing/service";
import { runSubscriptionTick } from "@/billing/tick";
import { createDb, type Db } from "@/db/client";
import { ensureBctonePlans, ensureInitialPlans } from "@/db/plans";
import { ensurePlatformTenant } from "@/db/platform";
import { auditLogs, clients, invoices, planQuotas, plans, subscriptions, users } from "@/db/schema";
import type { Actor, SendFn } from "@/jobs/service";
import { dateToTimestamp, timestampToDate } from "@/lib/billing";
import { BRIDGE_JOB_TYPES } from "@/lib/job-contract";

const URL_ = process.env.TEST_DATABASE_URL;
const META = { ip: "203.0.113.9", requestId: "req-bctone-admin" };
const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
const at = (d: string) => new Date(dateToTimestamp(d).getTime() + 7 * 3600_000);

describe.skipIf(!URL_)("BCTOne admin (D-1)", () => {
  let db: Db;
  let pool: { end: () => Promise<void> };
  let SUPER: Actor;
  let OPS: Actor;
  let tokoId: string;
  let ptId: string;
  const send: SendFn = async () => "unused";
  const svc = (actor: Actor, now?: Date): BillingServiceInput => ({
    actor,
    meta: META,
    instance: "prod",
    allowedTypes: [...BRIDGE_JOB_TYPES],
    send,
    ...(now ? { now } : {}),
  });
  const plan = async (code: string) => (await db.select().from(plans).where(eq(plans.code, code)))[0]!;

  beforeAll(async () => {
    ({ db, pool } = createDb(URL_!, { max: 2, applicationName: "cp-int-bctone-admin" }));
    await db.execute(sql`DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA IF EXISTS pgboss CASCADE; CREATE SCHEMA public;`);
    await migrate(db, { migrationsFolder: "./drizzle" });
    const platform = await ensurePlatformTenant(db);
    await ensureInitialPlans(db);
    await ensureBctonePlans(db);
    tokoId = (await db.insert(clients).values({ slug: "toko-a", name: "Toko A" }).returning())[0]!.id;
    ptId = (await db.insert(clients).values({ slug: "pt-b", name: "PT B" }).returning())[0]!.id;
    const [sa] = await db.insert(users).values({ keycloakSub: "super-sub", role: "superadmin", clientId: platform.id }).returning();
    const [op] = await db.insert(users).values({ keycloakSub: "ops-sub", role: "ops", clientId: platform.id }).returning();
    SUPER = { sub: "super-sub", userId: sa!.id, roles: ["superadmin"] };
    OPS = { sub: "ops-sub", userId: op!.id, roles: ["ops"] };
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
  });

  it("updatePlan: harga + kuota (ubah, hapus = tanpa batas), ops ditolak, diaudit", async () => {
    const umkm = await plan("bctone-umkm");
    expect(await updatePlan(db, svc(OPS), { planId: umkm.id, priceAmount: "1", isActive: true, limits: {} })).toEqual({ ok: false, reason: "forbidden" });
    const r = await updatePlan(db, svc(SUPER), {
      planId: umkm.id,
      priceAmount: "249000.00",
      isActive: true,
      limits: { users: 8, trx_per_month: null, omzet_per_month: 100_000_000 },
    });
    expect(r.ok).toBe(true);
    expect((await plan("bctone-umkm")).priceAmount).toBe("249000.00");
    const q = await db.select().from(planQuotas).where(eq(planQuotas.planId, umkm.id));
    const m = Object.fromEntries(q.map((x) => [x.metric, x.limitValue]));
    expect(m.users).toBe(8);
    expect(m.trx_per_month).toBeUndefined(); // dihapus = tanpa batas
    expect(m.omzet_per_month).toBe(100_000_000); // baru
    expect(m.devices).toBe(3); // tidak disentuh (tidak ada di limits)
    const a = (await db.select().from(auditLogs).where(eq(auditLogs.action, "plan.update")).orderBy(auditLogs.id)).at(-1)!;
    expect(a.result).toBe("success");
    expect((a.metadata as { changes: Record<string, unknown> }).changes).toMatchObject({
      price_amount: { from: "199000.00", to: "249000.00" },
      "limit.users": { from: 5, to: 8 },
      "limit.trx_per_month": { from: 5000, to: null },
    });
    expect(await updatePlan(db, svc(SUPER), { planId: umkm.id, priceAmount: "-5", isActive: true, limits: {} })).toEqual({ ok: false, reason: "invalid" });
  });

  it("Free: langganan langsung aktif self_serve, tanpa invoice", async () => {
    const free = await plan("bctone-free");
    const r = await createSubscription(db, svc(SUPER, at("2026-11-01")), { clientId: tokoId, planId: free.id, startsAt: "2026-11-01", now: at("2026-11-01") });
    expect(r.ok).toBe(true);
    const s = (await db.select().from(subscriptions).where(eq(subscriptions.id, (r as { id: string }).id)))[0]!;
    expect(s.status).toBe("active");
    expect(s.lifecycle).toBe("self_serve");
    expect(timestampToDate(s.currentPeriodStart)).toBe("2026-11-01");
    expect(timestampToDate(s.currentPeriodEnd)).toBe("2026-12-01");
    expect(await db.select().from(invoices).where(eq(invoices.clientId, tokoId))).toHaveLength(0);
  });

  it("UMKM + PPh 23: invoice pertama berpajak; lunas → periode maju; plan lama tetap implementation", async () => {
    expect(await setClientWithholding(db, svc(OPS), { clientId: ptId, withholdsPph23: true })).toEqual({ ok: false, reason: "forbidden" });
    expect((await setClientWithholding(db, svc(SUPER), { clientId: ptId, withholdsPph23: true })).ok).toBe(true);
    const umkm = await plan("bctone-umkm");
    await updatePlan(db, svc(SUPER), { planId: umkm.id, priceAmount: "199000.00", isActive: true, limits: {} });
    const r = await createSubscription(db, svc(SUPER, at("2026-11-01")), { clientId: ptId, planId: umkm.id, startsAt: "2026-11-01", now: at("2026-11-01") });
    expect(r.ok).toBe(true);
    const subId = (r as { id: string }).id;
    const inv = (await db.select().from(invoices).where(eq(invoices.subscriptionId, subId)))[0]!;
    expect(inv).toMatchObject({
      kind: "maintenance",
      amount: "199000.00",
      taxScheme: "ppn_dpp_nilai_lain",
      ppnAmount: "21890.00",
      pph23Amount: "3980.00",
      totalAmount: "220890.00",
      periodStart: "2026-11-01",
      periodEnd: "2026-12-01",
    });
    const paid = await markInvoicePaid(db, svc(SUPER, at("2026-11-02")), { invoiceId: inv.id, paidAt: "2026-11-02", paymentReference: "TRF-1", proofReference: "bukti-1" });
    expect(paid.ok).toBe(true);
    const s = (await db.select().from(subscriptions).where(eq(subscriptions.id, subId)))[0]!;
    // invoice pertama = periode berjalan → lunas memperpanjang ke periode berikutnya (bayar di muka) + invoice berikutnya
    expect(timestampToDate(s.currentPeriodEnd)).toBe("2027-01-01");
    const next = await db
      .select()
      .from(invoices)
      .where(and(eq(invoices.subscriptionId, subId), eq(invoices.periodStart, "2026-12-01")));
    expect(next).toHaveLength(1);
    expect(next[0]!.taxScheme).toBe("ppn_dpp_nilai_lain");

    const odoo = await plan("odoo-shared-m");
    const legacyClient = (await db.insert(clients).values({ slug: "lama-co", name: "Lama" }).returning())[0]!.id;
    // satu langganan per layanan: tenant BCTOne (layanan odoo) tidak bisa ditambah plan odoo lain
    expect(await createSubscription(db, svc(SUPER), { clientId: tokoId, planId: odoo.id })).toEqual({ ok: false, reason: "service_exists" });
    const legacy = await createSubscription(db, svc(SUPER), { clientId: legacyClient, planId: odoo.id });
    expect(legacy.ok).toBe(true);
    const ls = (await db.select().from(subscriptions).where(eq(subscriptions.id, (legacy as { id: string }).id)))[0]!;
    expect(ls.status).toBe("implementation");
    expect(ls.lifecycle).toBe("implementation");
  });

  it("tick tanpa perubahan untuk langganan self-serve yang baru dibuat", async () => {
    const rep = await runSubscriptionTick({
      db,
      send,
      instance: "prod",
      allowedTypes: [...BRIDGE_JOB_TYPES],
      logger: quiet,
      mailer: null,
      billingEmail: "billing@example.invalid",
      now: at("2026-11-15"),
      today: "2026-11-15",
    });
    expect(rep.errors).toBe(0);
    expect(rep.anomalies).toBe(0);
  });
});
