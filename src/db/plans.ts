import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "./client";
import { BCTONE_PLAN_QUOTAS, QUOTA_METRICS } from "../lib/bctone-quota";
import { planQuotas, plans } from "./schema";

type PlanSeed = Omit<typeof plans.$inferInsert, "id" | "createdAt" | "updatedAt" | "priceAmount" | "isActive">;

/**
 * Plan awal ADR 0018 D7 (Q4): harga NULL (diisi kemudian), periode bulanan, maintenance dimulai setelah garansi 2 bulan.
 * Batas di kolom (max_users/max_environments/max_mailboxes) + detail di `features` (belum ditegakkan Fase 1 kecuali
 * dibaca portal W6).
 */
export const INITIAL_PLANS: readonly PlanSeed[] = [
  {
    code: "odoo-shared-s",
    name: "Odoo Shared S",
    service: "odoo",
    billingPeriodMonths: 1,
    maxUsers: 5,
    maxEnvironments: 1,
    features: { isolation: "shared", environments: ["prod"] },
  },
  {
    code: "odoo-shared-m",
    name: "Odoo Shared M",
    service: "odoo",
    billingPeriodMonths: 1,
    maxUsers: 15,
    maxEnvironments: 2,
    features: { isolation: "shared", environments: ["prod", "demo"] },
  },
  {
    code: "odoo-dedicated",
    name: "Odoo Dedicated",
    service: "odoo",
    billingPeriodMonths: 1,
    maxUsers: null,
    maxEnvironments: null,
    features: { isolation: "dedicated", workers: 2, limits: "sesuai kontrak" },
  },
  {
    code: "mail-5",
    name: "Mail 5",
    service: "mail",
    billingPeriodMonths: 1,
    maxMailboxes: 5,
    features: { mailbox_quota_mb: 2048 },
  },
  {
    code: "mail-20",
    name: "Mail 20",
    service: "mail",
    billingPeriodMonths: 1,
    maxMailboxes: 20,
    features: { mailbox_quota_mb: 2048 },
  },
  {
    code: "web-profile",
    name: "Web Profile",
    service: "web",
    billingPeriodMonths: 1,
    features: { sites: 1, cms: true },
  },
  {
    code: "insight-basic",
    name: "Insight Basic",
    service: "insight",
    billingPeriodMonths: 1,
    features: { dashboards: "standard" },
  },
];

/**
 * Langkah boot idempoten (seperti tenant `platform`, db/migrate.ts): INSERT plan yang belum ada (berdasarkan `code`).
 * Plan yang sudah ada TIDAK diubah — harga/batas yang diisi kemudian tidak tertimpa saat migrasi berikutnya.
 */
export async function ensureInitialPlans(db: Db): Promise<{ created: number; total: number }> {
  const inserted = await db
    .insert(plans)
    .values(INITIAL_PLANS.map((p) => ({ ...p, priceAmount: null, isActive: true })))
    .onConflictDoNothing({ target: plans.code })
    .returning({ id: plans.id });
  const total = await db
    .select({ id: plans.id })
    .from(plans)
    .where(inArray(plans.code, INITIAL_PLANS.map((p) => p.code)));
  return { created: inserted.length, total: total.length };
}

/**
 * ADR 0019 (BCTOne, keputusan owner K-20): paket self-serve. Harga tanpa PPN (PPN dihitung per invoice, lib/bctone-tax.ts).
 * Free TIDAK punya harga (tanpa invoice). Bisnis dijual lewat sales (self_serve=false di features).
 */
export const BCTONE_PLANS: readonly (PlanSeed & { priceAmount: string | null })[] = [
  { code: "bctone-free", name: "BCTOne Free", service: "odoo", billingPeriodMonths: 1, maxUsers: 1, maxEnvironments: 1, priceAmount: null, features: { product: "bctone", self_serve: true, tier: "free" } },
  { code: "bctone-umkm", name: "BCTOne UMKM", service: "odoo", billingPeriodMonths: 1, maxUsers: 5, maxEnvironments: 1, priceAmount: "199000.00", features: { product: "bctone", self_serve: true, tier: "umkm" } },
  { code: "bctone-bisnis", name: "BCTOne Bisnis", service: "odoo", billingPeriodMonths: 1, maxUsers: 25, maxEnvironments: 1, priceAmount: "999000.00", features: { product: "bctone", self_serve: false, tier: "bisnis" } },
];

/**
 * Idempoten: INSERT plan BCTOne yang belum ada + kuota yang belum ada. Plan/kuota yang sudah ada TIDAK diubah
 * (harga/batas yang diubah lewat BCT Admin tidak tertimpa saat migrasi berikutnya).
 */
export async function ensureBctonePlans(db: Db): Promise<{ created: number; quotasCreated: number }> {
  const inserted = await db
    .insert(plans)
    .values(BCTONE_PLANS.map((p) => ({ ...p, isActive: true })))
    .onConflictDoNothing({ target: plans.code })
    .returning({ id: plans.id });
  const rows = await db.select({ id: plans.id, code: plans.code }).from(plans).where(inArray(plans.code, BCTONE_PLANS.map((p) => p.code)));
  let quotasCreated = 0;
  for (const r of rows) {
    const q = BCTONE_PLAN_QUOTAS[r.code];
    if (!q) continue;
    const values = QUOTA_METRICS.flatMap((m) => (q[m] === null ? [] : [{ planId: r.id, metric: m, limitValue: q[m] as number }]));
    if (values.length === 0) continue;
    const ins = await db.insert(planQuotas).values(values).onConflictDoNothing({ target: [planQuotas.planId, planQuotas.metric] }).returning({ planId: planQuotas.planId });
    quotasCreated += ins.length;
  }
  return { created: inserted.length, quotasCreated };
}

/** Batas kuota satu plan dari DB (metrik tanpa baris = tanpa batas). */
export async function planQuotaLimits(db: Db, planId: string): Promise<Partial<Record<(typeof QUOTA_METRICS)[number], number>>> {
  const rows = await db.select({ metric: planQuotas.metric, limit: planQuotas.limitValue }).from(planQuotas).where(and(eq(planQuotas.planId, planId)));
  return Object.fromEntries(rows.map((r) => [r.metric, r.limit]));
}
