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
    set: Partial<{ status: "active" | "revoked" | "failed"; kcUserId: string; odooUserId: number }>;
    /** Hanya ubah bila status saat ini `pending` (grant gagal). */
    onlyIfPending?: boolean;
  };
  warnings: string[];
}

const INT_RE = /^[0-9]{1,9}$/;
const CLIENT_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

export function planReconcile(job: ReconcileJob, envRow: ReconcileEnvRow): ReconcilePlan {
  const plan: ReconcilePlan = { env: {}, warnings: [] };
  const r = job.result;
  const isDry = job.dryRun || r.mode === "dry-run";

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
      if (job.args.action === "grant") set.status = "active";
      else if (job.args.action === "revoke") set.status = "revoked";
      plan.tenantUser = { email, set };
      break;
    }
  }
  return plan;
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
