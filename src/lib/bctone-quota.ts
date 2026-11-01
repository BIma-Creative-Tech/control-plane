/**
 * Kuota tenant BCTOne (ADR 0019 #3, BR-08..BR-12) — modul MURNI. Aturan sama dengan `@bctone/rules` (quota.ts).
 * - Transaksi & omzet: peringatan >= 80%, grace 10% di atas batas, lewat itu dokumen baru diblokir.
 * - User, device, prompt AI: tanpa grace.
 * Batas per plan disimpan di tabel `plan_quotas` (bukan hardcode) agar bisa diubah lewat BCT Admin.
 */

export const QUOTA_METRICS = ["users", "devices", "outlets", "trx_per_month", "omzet_per_month", "ai_prompts_per_day"] as const;
export type QuotaMetric = (typeof QUOTA_METRICS)[number];
export type QuotaState = "ok" | "warn" | "grace" | "blocked";

export const QUOTA_WARN_RATIO = 0.8;
export const QUOTA_GRACE_RATIO = 0.1;
const GRACE_METRICS: ReadonlySet<QuotaMetric> = new Set(["trx_per_month", "omzet_per_month"]);

export function isQuotaMetric(v: unknown): v is QuotaMetric {
  return typeof v === "string" && (QUOTA_METRICS as readonly string[]).includes(v);
}

export function quotaHardStop(metric: QuotaMetric, limit: number): number {
  return GRACE_METRICS.has(metric) ? Math.floor(limit * (1 + QUOTA_GRACE_RATIO)) : limit;
}

/** `limit` null = tanpa batas. */
export function quotaState(metric: QuotaMetric, limit: number | null, used: number): QuotaState {
  if (!Number.isFinite(used) || used < 0) throw new RangeError("pemakaian tidak valid");
  if (limit === null) return "ok";
  if (used > quotaHardStop(metric, limit)) return "blocked";
  if (used > limit) return "grace";
  if (used >= limit * QUOTA_WARN_RATIO) return "warn";
  return "ok";
}

export function canConsumeQuota(metric: QuotaMetric, limit: number | null, usedBefore: number, amount = 1): boolean {
  if (limit === null) return true;
  return usedBefore + amount <= quotaHardStop(metric, limit);
}

/** Seed batas paket BCTOne (keputusan owner K-19/K-20). `null` = tanpa batas. Kode plan diawali `bctone-`. */
export const BCTONE_PLAN_QUOTAS: Readonly<Record<string, Readonly<Record<QuotaMetric, number | null>>>> = {
  "bctone-free": { users: 1, devices: 1, outlets: 1, trx_per_month: 300, omzet_per_month: 25_000_000, ai_prompts_per_day: 3 },
  "bctone-umkm": { users: 5, devices: 3, outlets: 2, trx_per_month: 5_000, omzet_per_month: null, ai_prompts_per_day: 30 },
  "bctone-bisnis": { users: 25, devices: 10, outlets: 10, trx_per_month: 50_000, omzet_per_month: null, ai_prompts_per_day: 150 },
};
