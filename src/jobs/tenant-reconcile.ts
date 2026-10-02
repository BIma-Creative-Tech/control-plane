/**
 * Rekonsiliasi job tenant (kontrak Fase 1 §1.1/§4, ADR 0018 D6) dari RESULT dispatcher, di transaksi finalisasi worker:
 * - `tenant_suspend` / `tenant_resume` RESULT `state=suspended|active` → `clients.status` (tenant terminated/platform
 *   tidak pernah diubah). RESULT yang bertentangan dengan tipe job (suspend → active) tidak dipercaya: peringatan saja.
 * - `odoo_tenant_config` RESULT `mode=off|compat|strict` → `environments.tenant_check` env job itu (nilai host = fakta).
 * `planTenantReconcile` murni (diuji unit); `applyTenantReconcile` menjalankan rencana via Drizzle.
 */
import { and, eq, ne, sql } from "drizzle-orm";
import { clients, environments } from "../db/schema";
import { TENANT_CHECK_MODES, type TenantEnv } from "../lib/job-contract";
import type { Tx } from "./service";

export interface TenantReconcileJob {
  type: string;
  env: TenantEnv;
  dryRun: boolean;
  clientId: string | null;
  args: Record<string, unknown>;
  status: "succeeded" | "failed";
  result: Record<string, string>;
}

export type TenantReconcilePlan =
  | { kind: "none"; warnings: string[] }
  | { kind: "tenant_status"; clientId: string; status: "suspended" | "active"; warnings: string[] }
  | { kind: "tenant_check"; clientId: string; env: TenantEnv; mode: (typeof TENANT_CHECK_MODES)[number]; warnings: string[] };

export function planTenantReconcile(job: TenantReconcileJob): TenantReconcilePlan {
  const warnings: string[] = [];
  const r = job.result;
  if (job.type !== "tenant_suspend" && job.type !== "tenant_resume" && job.type !== "odoo_tenant_config") return { kind: "none", warnings };
  if (job.status !== "succeeded" || job.dryRun || r.mode === "dry-run" || r.mode === "plan") return { kind: "none", warnings };
  if (!job.clientId) return { kind: "none", warnings: ["job tanpa client_id — tidak direkonsiliasi"] };
  if (job.type === "odoo_tenant_config") {
    const mode = r.mode;
    if (!(TENANT_CHECK_MODES as readonly string[]).includes(mode ?? "")) return { kind: "none", warnings: ["RESULT mode tidak valid"] };
    if (mode !== job.args.tenant_check) warnings.push("RESULT mode berbeda dengan tenant_check yang diminta — nilai host disimpan");
    return { kind: "tenant_check", clientId: job.clientId, env: job.env, mode: mode as (typeof TENANT_CHECK_MODES)[number], warnings };
  }
  const expected = job.type === "tenant_suspend" ? "suspended" : "active";
  if (r.state !== "suspended" && r.state !== "active") return { kind: "none", warnings: ["RESULT state tidak ada/tidak valid"] };
  if (r.state !== expected) return { kind: "none", warnings: [`RESULT state=${r.state} bertentangan dengan ${job.type} — clients.status tidak diubah`] };
  return { kind: "tenant_status", clientId: job.clientId, status: r.state, warnings };
}

export async function applyTenantReconcile(tx: Tx, plan: TenantReconcilePlan): Promise<void> {
  switch (plan.kind) {
    case "none":
      return;
    case "tenant_status":
      await tx
        .update(clients)
        .set({ status: plan.status, updatedAt: sql`now()` })
        .where(and(eq(clients.id, plan.clientId), ne(clients.status, "terminated"), eq(clients.isPlatform, false)));
      return;
    case "tenant_check":
      await tx
        .update(environments)
        .set({ tenantCheck: plan.mode, updatedAt: sql`now()` })
        .where(and(eq(environments.clientId, plan.clientId), eq(environments.kind, plan.env)));
      return;
  }
}
