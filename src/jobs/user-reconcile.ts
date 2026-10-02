/**
 * Rekonsiliasi job identitas SaaS Fase 1 → `users` / `clients` / `tenant_user_access` (kontrak §2.3): baris diisi
 * dari RESULT dispatcher (id user Keycloak = `sub`), bukan dari input form. Dipanggil worker di transaksi finalisasi.
 * `planUserReconcile` murni (diuji unit); `applyUserReconcile` menjalankan rencana via Drizzle.
 *
 * Ini juga jalur yang membuat baris `users` untuk user yang dibuat lewat CP (temuan "users prod kosong",
 * docs/temuan-users-prod-kosong.md) — tidak lagi hanya bergantung pada login.
 */
import { and, eq, sql } from "drizzle-orm";
import { isUniqueViolation } from "../db/errors";
import { auditLogs, clients, environments, tenantUserAccess, users } from "../db/schema";
import { UUID_REGEX, emailHash, type SaasP1JobType, type TenantEnv } from "../lib/job-contract";
import type { Role } from "../lib/roles";
import type { Tx } from "./service";

export interface UserReconcileJob {
  id: string;
  type: SaasP1JobType;
  env: TenantEnv;
  dryRun: boolean;
  clientId: string | null;
  actorUserId: string | null;
  args: Record<string, unknown>;
  status: "succeeded" | "failed";
  result: Record<string, string>;
}

export type UserReconcilePlan =
  | { kind: "none"; warnings: string[] }
  | { kind: "org"; clientId: string; kcOrgId: string; warnings: string[] }
  | {
      kind: "user_ensure";
      clientId: string;
      sub: string;
      email: string;
      displayName: string | null;
      invitedBy: string | null;
      warnings: string[];
    }
  | { kind: "user_role"; clientId: string; sub: string | null; email: string; role: Role; warnings: string[] }
  | { kind: "user_enabled"; clientId: string; sub: string | null; email: string; enabled: boolean; warnings: string[] }
  | {
      kind: "odoo_access";
      clientId: string;
      env: TenantEnv;
      email: string;
      isAdmin: boolean;
      active: boolean;
      kcUserId: string | null;
      odooUserId: number | null;
      login: string | null;
      invitedBy: string | null;
      warnings: string[];
    };

const INT_RE = /^[0-9]{1,9}$/;
/** id Organization Keycloak (UUID); nilai lain tidak disimpan. */
const ORG_ID_RE = UUID_REGEX;

export function planUserReconcile(job: UserReconcileJob): UserReconcilePlan {
  const warnings: string[] = [];
  const r = job.result;
  if (job.status !== "succeeded" || job.dryRun || r.mode === "dry-run" || r.mode === "plan") return { kind: "none", warnings };
  if (!job.clientId) return { kind: "none", warnings: ["job tanpa client_id — tidak direkonsiliasi"] };
  const email = typeof job.args.email === "string" ? job.args.email : null;
  const kcUser = r.kc_user && UUID_REGEX.test(r.kc_user) ? r.kc_user : null;

  switch (job.type) {
    case "kc_org_ensure":
      if (r.org && ORG_ID_RE.test(r.org)) return { kind: "org", clientId: job.clientId, kcOrgId: r.org, warnings };
      return { kind: "none", warnings: ["RESULT org tidak valid"] };
    case "kc_user_ensure":
      if (!email) return { kind: "none", warnings };
      if (!kcUser) return { kind: "none", warnings: ["RESULT kc_user tidak valid — baris users tidak dibuat"] };
      return {
        kind: "user_ensure",
        clientId: job.clientId,
        sub: kcUser,
        email,
        displayName: typeof job.args.name === "string" ? job.args.name : null,
        invitedBy: job.actorUserId,
        warnings,
      };
    case "kc_user_set_roles": {
      if (!email) return { kind: "none", warnings };
      const role = job.args.cp_role;
      // `none` = semua role CP dicabut; cache role (enum tanpa `none`) dibiarkan — otorisasi tetap dari klaim.
      if (role === "superadmin" || role === "ops" || role === "client_admin" || role === "client_user") {
        return { kind: "user_role", clientId: job.clientId, sub: kcUser, email, role, warnings };
      }
      return { kind: "none", warnings };
    }
    case "kc_user_set_enabled":
      if (!email || typeof job.args.enabled !== "boolean") return { kind: "none", warnings };
      return { kind: "user_enabled", clientId: job.clientId, sub: kcUser, email, enabled: job.args.enabled, warnings };
    case "odoo_user_ensure":
      if (!email || typeof job.args.active !== "boolean") return { kind: "none", warnings };
      return {
        kind: "odoo_access",
        clientId: job.clientId,
        env: job.env,
        email,
        isAdmin: job.args.role === "admin",
        active: job.args.active,
        kcUserId: kcUser,
        odooUserId: r.odoo_user && INT_RE.test(r.odoo_user) ? Number(r.odoo_user) : null,
        login: typeof job.args.login === "string" ? job.args.login : null,
        invitedBy: job.actorUserId,
        warnings,
      };
    default:
      // kc_realm_sync, kc_user_action_email, odoo_tenant_config, tenant_*: tidak ada kolom CP yang diturunkan (Fase 1).
      return { kind: "none", warnings };
  }
}

/** Cari baris users: utamakan `sub` dari RESULT, lalu email+tenant. */
async function findUser(tx: Tx, clientId: string, sub: string | null, email: string) {
  if (sub) {
    const bySub = await tx.select().from(users).where(eq(users.keycloakSub, sub)).limit(1);
    if (bySub[0]) return bySub[0];
  }
  const byEmail = await tx
    .select()
    .from(users)
    .where(and(eq(users.email, email), eq(users.clientId, clientId)))
    .limit(1);
  return byEmail[0] ?? null;
}

async function auditWarn(tx: Tx, job: UserReconcileJob, action: string, md: Record<string, unknown>) {
  await tx.insert(auditLogs).values({
    actor: "system:worker",
    action,
    targetType: "user",
    targetId: null,
    clientId: job.clientId,
    result: "failure",
    metadata: { job_id: job.id, type: job.type, ...(typeof job.args.email === "string" ? { email_hash: emailHash(job.args.email) } : {}), ...md },
  });
}

/**
 * Terapkan rencana. Konflik (lintas tenant, aturan satu admin) TIDAK menggagalkan finalisasi job — dicatat sebagai
 * peringatan + audit `user.reconcile_conflict` (job di host sudah selesai; status nyata tetap di Keycloak).
 * Mengembalikan peringatan tambahan untuk log worker.
 */
export async function applyUserReconcile(tx: Tx, job: UserReconcileJob, plan: UserReconcilePlan): Promise<string[]> {
  const warnings: string[] = [];
  switch (plan.kind) {
    case "none":
      return warnings;
    case "org":
      await tx.update(clients).set({ kcOrgId: plan.kcOrgId, updatedAt: sql`now()` }).where(eq(clients.id, plan.clientId));
      return warnings;
    case "user_ensure": {
      const existing = (await tx.select().from(users).where(eq(users.keycloakSub, plan.sub)).limit(1))[0];
      if (!existing) {
        const tenant = (await tx.select({ isPlatform: clients.isPlatform }).from(clients).where(eq(clients.id, plan.clientId)).limit(1))[0];
        await tx.insert(users).values({
          keycloakSub: plan.sub,
          email: plan.email,
          displayName: plan.displayName,
          // Cache role awal paling rendah; diperbarui oleh kc_user_set_roles di rantai yang sama.
          role: tenant?.isPlatform ? "ops" : "client_user",
          clientId: plan.clientId,
          status: "invited",
          invitedBy: plan.invitedBy,
        });
        return warnings;
      }
      if (existing.clientId !== null && existing.clientId !== plan.clientId) {
        warnings.push("users.client_id berbeda dengan tenant job — tidak diubah (lintas tenant)");
        await auditWarn(tx, job, "user.reconcile_conflict", { conflict: "cross_tenant" });
        return warnings;
      }
      await tx
        .update(users)
        .set({
          email: plan.email,
          clientId: plan.clientId,
          ...(existing.displayName === null && plan.displayName ? { displayName: plan.displayName } : {}),
          updatedAt: sql`now()`,
        })
        .where(eq(users.id, existing.id));
      return warnings;
    }
    case "user_role": {
      const u = await findUser(tx, plan.clientId, plan.sub, plan.email);
      if (!u) {
        warnings.push("baris users tidak ditemukan untuk kc_user_set_roles");
        return warnings;
      }
      if (u.clientId !== plan.clientId) {
        warnings.push("users.client_id berbeda dengan tenant job — role tidak diubah");
        await auditWarn(tx, job, "user.reconcile_conflict", { conflict: "cross_tenant" });
        return warnings;
      }
      try {
        // Savepoint: pelanggaran users_one_tenant_admin_uq tidak boleh membatalkan finalisasi job.
        await tx.transaction(async (sp) => {
          await sp.update(users).set({ role: plan.role, updatedAt: sql`now()` }).where(eq(users.id, u.id));
        });
      } catch (err) {
        if (!isUniqueViolation(err, "users_one_tenant_admin_uq")) throw err;
        warnings.push("aturan satu tenant-admin: cache role tidak diubah");
        await auditWarn(tx, job, "user.reconcile_conflict", { conflict: "one_admin" });
      }
      return warnings;
    }
    case "user_enabled": {
      const u = await findUser(tx, plan.clientId, plan.sub, plan.email);
      if (!u || u.clientId !== plan.clientId) {
        warnings.push("baris users tidak ditemukan / lintas tenant untuk kc_user_set_enabled");
        return warnings;
      }
      try {
        await tx.transaction(async (sp) => {
          await sp
            .update(users)
            .set(
              plan.enabled
                ? { status: u.status === "disabled" ? "active" : u.status, disabledAt: null, updatedAt: sql`now()` }
                : { status: "disabled", disabledAt: sql`now()`, updatedAt: sql`now()` },
            )
            .where(eq(users.id, u.id));
        });
      } catch (err) {
        if (!isUniqueViolation(err, "users_one_tenant_admin_uq")) throw err;
        warnings.push("aturan satu tenant-admin: status tidak diubah");
        await auditWarn(tx, job, "user.reconcile_conflict", { conflict: "one_admin" });
      }
      return warnings;
    }
    case "odoo_access": {
      const env = (
        await tx
          .select({ id: environments.id })
          .from(environments)
          .where(and(eq(environments.clientId, plan.clientId), eq(environments.kind, plan.env)))
          .limit(1)
      )[0];
      if (!env) {
        warnings.push("environment tenant untuk env job tidak ada — tenant_user_access tidak diubah");
        return warnings;
      }
      const set = {
        isTenantAdmin: plan.isAdmin,
        status: plan.active ? ("active" as const) : ("revoked" as const),
        ...(plan.kcUserId ? { kcUserId: plan.kcUserId } : {}),
        ...(plan.odooUserId !== null ? { odooUserId: plan.odooUserId } : {}),
        ...(plan.login ? { odooLogin: plan.login } : {}),
        lastJobId: job.id,
      };
      await tx
        .insert(tenantUserAccess)
        .values({ environmentId: env.id, email: plan.email, invitedBy: plan.invitedBy, ...set })
        .onConflictDoUpdate({
          target: [tenantUserAccess.environmentId, tenantUserAccess.email],
          set: { ...set, updatedAt: sql`now()` },
        });
      return warnings;
    }
  }
}
