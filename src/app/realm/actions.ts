"use server";

/**
 * Sync realm (SaaS Fase 1 W5, ADR 0017 D7, kontrak §1 kc_realm_sync). Permission `realm:sync` (superadmin) di Server
 * Action DAN di layanan. Rencana = dry-run; Terapkan = ketik nama realm + (prod/demo) checkbox persetujuan → approve=true.
 */
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@/db";
import { safeErrorMessage } from "@/db/errors";
import { getWebEnv } from "@/env";
import { requestRealmSync, tenantOutcomeCode, tenantOutcomeLog, type TenantActionOutcome } from "@/jobs/tenants";
import { requirePermission } from "@/lib/authz";
import { instanceJobTypes } from "@/lib/job-contract";
import type { ActionResultCode } from "@/lib/job-list-params";
import { logger } from "@/lib/logger";
import { parseTenantForm } from "@/lib/tenant-onboarding";
import { getSendFn } from "@/server/boss";
import { actorFromSession, assertSameOrigin, requestMeta } from "@/server/context";

function back(code: ActionResultCode, chainId?: string): never {
  const q = new URLSearchParams({ r: code });
  if (chainId) q.set("chain", chainId);
  redirect(`/realm?${q.toString()}`);
}

async function run(mode: "plan" | "apply", formData: FormData): Promise<never> {
  const session = await requirePermission("realm:sync");
  if (!(await assertSameOrigin())) back("origin");
  const env = getWebEnv();
  const instance = env.INFRA_JOBS_INSTANCE;
  if (!instance) back("disabled");
  const parsed = mode === "plan" ? parseTenantForm("realmPlan", formData.entries()) : parseTenantForm("realmApply", formData.entries());
  if (!parsed.success) back("invalid");
  const actor = await actorFromSession(session);
  if (!actor) back("reauth");
  const data = parsed.data as { confirm?: string; approve?: boolean };
  let outcome: TenantActionOutcome;
  try {
    outcome = await requestRealmSync(getDb(), await getSendFn(), {
      instance,
      allowedTypes: instanceJobTypes(env.INFRA_JOBS_TYPES),
      actor,
      meta: await requestMeta(),
      mode,
      confirmRealm: data.confirm ?? null,
      approveChecked: data.approve === true,
    });
  } catch (err) {
    logger.error({ err: safeErrorMessage(err) }, "sync realm gagal");
    back("error");
  }
  const msg = tenantOutcomeLog(outcome);
  if (msg) logger.error({ err: msg }, "sync realm gagal");
  revalidatePath("/realm");
  back(tenantOutcomeCode(outcome), outcome.ok ? outcome.chainId : undefined);
}

export async function realmSyncPlanAction(formData: FormData): Promise<void> {
  await run("plan", formData);
}

export async function realmSyncApplyAction(formData: FormData): Promise<void> {
  await run("apply", formData);
}
