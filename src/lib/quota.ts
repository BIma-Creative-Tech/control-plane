/**
 * Kuota enqueue di control plane (plan 05 §4.4 Q5). Batas SAMA dengan kuota dispatcher per instance
 * (dispatcher tetap penegak utama: `rejected_quota`); CP menolak lebih awal agar ops mendapat umpan balik
 * langsung dan tidak menghasilkan alert. Ditambah batas per aktor (rate limit Server Action, §3.6).
 * Modul murni — hitungan diambil dari DB oleh pemanggil.
 */
import type { BridgeJobType } from "./job-contract";

export const QUOTA = {
  totalPerHour: 60,
  dbProvisionPerDay: 3,
  ssoUserPerHour: 30,
  rotateSecretPerDay: 5,
  /** Rate limit per aktor (anti double-submit/skrip): 10 job/menit. */
  perActorPerMinute: 10,
} as const;

export interface QuotaCounts {
  /** Job bridge dibuat (semua aktor, instance ini) dalam 1 jam terakhir. */
  totalLastHour: number;
  dbProvisionLastDay: number;
  ssoUserLastHour: number;
  rotateSecretLastDay: number;
  actorLastMinute: number;
}

export type QuotaViolation = "actor_rate" | "total_hour" | "db_provision_day" | "sso_user_hour" | "rotate_secret_day";

export function evaluateQuota(
  counts: QuotaCounts,
  job: { type: BridgeJobType; rotateSecret: boolean },
): QuotaViolation | null {
  if (counts.actorLastMinute >= QUOTA.perActorPerMinute) return "actor_rate";
  if (counts.totalLastHour >= QUOTA.totalPerHour) return "total_hour";
  if (job.type === "odoo_db_provision" && counts.dbProvisionLastDay >= QUOTA.dbProvisionPerDay) return "db_provision_day";
  if (job.type === "odoo_sso_user" && counts.ssoUserLastHour >= QUOTA.ssoUserPerHour) return "sso_user_hour";
  if (job.rotateSecret && counts.rotateSecretLastDay >= QUOTA.rotateSecretPerDay) return "rotate_secret_day";
  return null;
}
