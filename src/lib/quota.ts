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

// ---------------------------------------------------------------------------
// Kontrak Fase 1 §1.2 — kuota tipe baru (= DEFAULT_QUOTA dispatcher) untuk rantai job (jobs/chain.ts).
// ---------------------------------------------------------------------------
export const P1_QUOTA = {
  /** semua kc_user_* (termasuk dry_run). */
  kcUserPerHour: 60,
  /** kc_user_set_enabled enabled=false, dry_run=false. */
  kcUserDisablePerHour: 20,
  kcActionEmailPerHour: 20,
  kcRealmSyncPerDay: 10,
  /** tenant_suspend + tenant_resume. */
  tenantStatePerDay: 20,
  odooUserPerHour: 60,
  /** Rate limit per aktor: rantai (atau job tunggal) per menit — satu klik = satu rantai. */
  chainsPerActorPerMinute: 10,
} as const;

/** Kategori kuota satu langkah rantai (murni). */
export interface QuotaStep {
  type: BridgeJobType;
  dryRun: boolean;
  args: Record<string, unknown>;
}

export interface ChainQuotaCounts {
  totalLastHour: number;
  kcUserLastHour: number;
  kcUserDisableLastHour: number;
  kcActionEmailLastHour: number;
  kcRealmSyncLastDay: number;
  tenantStateLastDay: number;
  odooUserLastHour: number;
  /** Rantai/job tunggal (distinct coalesce(chain_id, id)) aktor ini dalam 1 menit terakhir. */
  actorChainsLastMinute: number;
  /**
   * odoo_db_provision apply 24 jam terakhir (rantai onboarding tenant memuat tipe lama — kuota dispatcher
   * `odoo_db_provision` 3/hari berlaku juga untuk rantai). Opsional: tidak diisi = 0.
   */
  dbProvisionLastDay?: number;
}

export type ChainQuotaViolation =
  | "actor_rate"
  | "total_hour"
  | "kc_user_hour"
  | "kc_user_disable_hour"
  | "kc_action_email_hour"
  | "kc_realm_sync_day"
  | "tenant_state_day"
  | "odoo_user_hour"
  | "db_provision_day";

export function plannedChainCounts(steps: readonly QuotaStep[]): Required<Omit<ChainQuotaCounts, "actorChainsLastMinute">> {
  const n = (f: (s: QuotaStep) => boolean) => steps.filter(f).length;
  return {
    totalLastHour: steps.length,
    kcUserLastHour: n((s) => s.type.startsWith("kc_user_")),
    kcUserDisableLastHour: n((s) => s.type === "kc_user_set_enabled" && !s.dryRun && s.args.enabled === false),
    kcActionEmailLastHour: n((s) => s.type === "kc_user_action_email"),
    kcRealmSyncLastDay: n((s) => s.type === "kc_realm_sync"),
    tenantStateLastDay: n((s) => s.type === "tenant_suspend" || s.type === "tenant_resume"),
    odooUserLastHour: n((s) => s.type === "odoo_user_ensure"),
    dbProvisionLastDay: n((s) => s.type === "odoo_db_provision" && !s.dryRun),
  };
}

/**
 * Kuota rantai: hitungan saat ini + langkah yang AKAN dibuat tidak boleh melewati batas (seluruh rantai ditolak,
 * bukan sebagian — rantai setengah jadi lebih buruk daripada penolakan). Langkah yang di-dedupe tidak dihitung.
 */
export function evaluateChainQuota(counts: ChainQuotaCounts, steps: readonly QuotaStep[]): ChainQuotaViolation | null {
  if (counts.actorChainsLastMinute >= P1_QUOTA.chainsPerActorPerMinute) return "actor_rate";
  const p = plannedChainCounts(steps);
  if (counts.totalLastHour + p.totalLastHour > QUOTA.totalPerHour) return "total_hour";
  if (counts.kcUserLastHour + p.kcUserLastHour > P1_QUOTA.kcUserPerHour) return "kc_user_hour";
  if (counts.kcUserDisableLastHour + p.kcUserDisableLastHour > P1_QUOTA.kcUserDisablePerHour) return "kc_user_disable_hour";
  if (counts.kcActionEmailLastHour + p.kcActionEmailLastHour > P1_QUOTA.kcActionEmailPerHour) return "kc_action_email_hour";
  if (counts.kcRealmSyncLastDay + p.kcRealmSyncLastDay > P1_QUOTA.kcRealmSyncPerDay) return "kc_realm_sync_day";
  if (counts.tenantStateLastDay + p.tenantStateLastDay > P1_QUOTA.tenantStatePerDay) return "tenant_state_day";
  if (counts.odooUserLastHour + p.odooUserLastHour > P1_QUOTA.odooUserPerHour) return "odoo_user_hour";
  if ((counts.dbProvisionLastDay ?? 0) + p.dbProvisionLastDay > QUOTA.dbProvisionPerDay) return "db_provision_day";
  return null;
}
