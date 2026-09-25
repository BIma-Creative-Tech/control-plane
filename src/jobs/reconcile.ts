/**
 * Rekonsiliasi hasil job final → environments / tenant_user_access (plan 05 §7): kolom status diisi
 * dari RESULT dispatcher (bukan dari input form). Dipanggil worker di dalam transaksi finalisasi.
 * Fungsi `planReconcile` murni (diuji unit); `applyReconcile` menjalankan rencana via Drizzle.
 */
import { and, eq, sql } from "drizzle-orm";
import { environments, tenantUserAccess } from "../db/schema";
import { UUID_REGEX, isValidHostForEnv, type BridgeJobType, type TenantEnv } from "../lib/job-contract";
import type { Tx } from "./service";

export interface ReconcileJob {
  id: string;
  type: BridgeJobType;
  env: TenantEnv;
  dryRun: boolean;
  args: Record<string, unknown>;
  status: "succeeded" | "failed";
  result: Record<string, string>;
}

export interface ReconcileEnvRow {
  dbName: string;
}

export interface ReconcilePlan {
  env: Partial<{
    host: string;
    dbStatus: "provisioned";
    routeStatus: "active" | "removed";
    ssoStatus: "active" | "disabled";
    ssoClientId: string;
    ssoProviderId: number;
  }>;
  tenantUser?: {
    email: string;
    set: Partial<{ status: "active" | "revoked" | "failed" | "inconsistent"; kcUserId: string; odooUserId: number }>;
    /** Hanya ubah bila status saat ini `pending` (grant gagal). */
    onlyIfPending?: boolean;
  };
  warnings: string[];
  /**
   * BUG-J5-01: RESULT `action` tidak cocok dengan aksi yang diminta (atau hilang pada apply sukses). Pemanggil
   * menandai job `failed`/`result_inconsistent` dan menulis audit `job.result_inconsistent` — RESULT tidak
   * dipercaya diam-diam.
   */
  inconsistent?: { expected: string; reported: string | null };
}

const INT_RE = /^[0-9]{1,9}$/;
const CLIENT_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

export function planReconcile(job: ReconcileJob, envRow: ReconcileEnvRow): ReconcilePlan {
  const plan: ReconcilePlan = { env: {}, warnings: [] };
  const r = job.result;
  const isDry = job.dryRun || r.mode === "dry-run";

  if (job.type === "odoo_sso_user") {
    const mismatch = ssoUserActionMismatch(job, isDry);
    if (mismatch) {
      plan.inconsistent = mismatch;
      plan.warnings.push("RESULT action tidak cocok dengan aksi odoo_sso_user yang diminta");
      // Baris akses ditandai hanya untuk apply (dry-run tidak mengubah apa pun di host).
      if (!isDry && typeof job.args.email === "string") {
        const set: NonNullable<ReconcilePlan["tenantUser"]>["set"] = { status: "inconsistent" };
        if (r.kc_user && UUID_REGEX.test(r.kc_user)) set.kcUserId = r.kc_user;
        if (r.odoo_user && INT_RE.test(r.odoo_user)) set.odooUserId = Number(r.odoo_user);
        plan.tenantUser = { email: job.args.email, set };
      }
      return plan;
    }
  }

  if (job.status === "failed") {
    if (job.type === "odoo_sso_user" && job.args.action === "grant" && !job.dryRun && typeof job.args.email === "string") {
      plan.tenantUser = { email: job.args.email, set: { status: "failed" }, onlyIfPending: true };
    }
    return plan;
  }
  if (isDry) return plan;

  switch (job.type) {
    case "odoo_db_provision":
      if (r.db === envRow.dbName) plan.env.dbStatus = "provisioned";
      else plan.warnings.push("result.db tidak cocok dengan environments.db_name");
      break;
    case "odoo_route":
      if (job.args.remove === true) {
        plan.env.routeStatus = "removed";
      } else if (r.host && isValidHostForEnv(r.host, job.env)) {
        plan.env.routeStatus = "active";
        plan.env.host = r.host;
      } else {
        plan.warnings.push("result.host tidak valid untuk env");
      }
      break;
    case "odoo_sso_provision":
      plan.env.ssoStatus = "active";
      if (r.client && CLIENT_ID_RE.test(r.client)) plan.env.ssoClientId = r.client;
      if (r.provider && INT_RE.test(r.provider)) plan.env.ssoProviderId = Number(r.provider);
      break;
    case "odoo_sso_disable":
      plan.env.ssoStatus = "disabled";
      break;
    case "odoo_sso_user": {
      const email = job.args.email;
      if (typeof email !== "string") break;
      const set: NonNullable<ReconcilePlan["tenantUser"]>["set"] = {};
      if (r.kc_user && UUID_REGEX.test(r.kc_user)) set.kcUserId = r.kc_user;
      if (r.odoo_user && INT_RE.test(r.odoo_user)) set.odooUserId = Number(r.odoo_user);
      // Status dari RESULT `action` (sudah dipastikan = aksi diminta oleh ssoUserActionMismatch).
      // resend_invite tidak pernah mengubah status (hanya mengirim ulang execute-actions-email).
      if (r.action === "grant") set.status = "active";
      else if (r.action === "revoke") set.status = "revoked";
      plan.tenantUser = { email, set };
      break;
    }
  }
  return plan;
}

/**
 * Bandingkan RESULT `action` dengan aksi yang diminta (`args.action`):
 * - RESULT punya `action` berbeda → tidak konsisten (sukses maupun gagal, apply maupun dry-run);
 * - apply `succeeded` tanpa `action` → tidak konsisten (status tidak bisa diturunkan dari RESULT);
 * - job gagal / dry-run tanpa `action` → normal (dispatcher menolak sebelum skrip / RESULT dry-run).
 */
export function ssoUserActionMismatch(
  job: Pick<ReconcileJob, "status" | "args" | "result">,
  isDry: boolean,
): { expected: string; reported: string | null } | null {
  const expected = typeof job.args.action === "string" ? job.args.action : "?";
  const reported = typeof job.result.action === "string" ? job.result.action : null;
  if (reported === null) {
    return job.status === "succeeded" && !isDry ? { expected, reported: null } : null;
  }
  return reported === expected ? null : { expected, reported };
}

export async function applyReconcile(
  tx: Tx,
  environmentId: string,
  jobId: string,
  plan: ReconcilePlan,
): Promise<void> {
  await tx
    .update(environments)
    .set({ ...plan.env, lastJobId: jobId, updatedAt: sql`now()` })
    .where(eq(environments.id, environmentId));
  if (plan.tenantUser) {
    const where = and(
      eq(tenantUserAccess.environmentId, environmentId),
      eq(tenantUserAccess.email, plan.tenantUser.email),
      ...(plan.tenantUser.onlyIfPending ? [eq(tenantUserAccess.status, "pending")] : []),
    );
    await tx
      .update(tenantUserAccess)
      .set({ ...plan.tenantUser.set, updatedAt: sql`now()` })
      .where(where);
  }
}
