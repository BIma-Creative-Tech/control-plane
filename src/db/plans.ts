import { inArray } from "drizzle-orm";
import type { Db } from "./client";
import { plans } from "./schema";

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
