import "server-only";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { billingLogMessage, billingOutcomeCode, type BillingOutcome, type BillingServiceInput } from "@/billing/service";
import { getWebEnv } from "@/env";
import { requirePermission } from "@/lib/authz";
import { parseBillingForm, type BillingFormData, type BillingFormName } from "@/lib/billing-forms";
import { instanceJobTypes } from "@/lib/job-contract";
import type { ActionResultCode } from "@/lib/job-list-params";
import { logger } from "@/lib/logger";
import type { Permission } from "@/lib/roles";
import { getSendFn } from "@/server/boss";
import { actorFromSession, assertSameOrigin, requestMeta } from "@/server/context";

const BACK_RE = /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/;

export type BillingPath = "/subscriptions" | "/invoices";

function back(path: BillingPath, tenant: string | null, code: ActionResultCode): never {
  const q = new URLSearchParams();
  if (tenant) q.set("tenant", tenant);
  q.set("r", code);
  redirect(`${path}?${q.toString()}`);
}

/**
 * Kerangka Server Action billing (pola app/users/actions.ts): izin → Origin fail-closed → Zod `.strict()` → aktor (sub
 * Keycloak) → layanan billing/service.ts (izin dicek ULANG + transaksi + audit) → redirect dengan kode ter-whitelist.
 * `back` (slug filter tenant) hanya untuk redirect, bukan bagian skema aksi.
 */
export async function handleBillingAction<N extends BillingFormName>(
  form: N,
  permission: Permission,
  path: BillingPath,
  formData: FormData,
  call: (svc: BillingServiceInput, data: BillingFormData<N>) => Promise<BillingOutcome>,
): Promise<never> {
  const session = await requirePermission(permission);
  const rawBack = formData.get("back");
  const tenant = typeof rawBack === "string" && BACK_RE.test(rawBack) ? rawBack : null;
  formData.delete("back");
  if (!(await assertSameOrigin())) back(path, tenant, "origin");
  const parsed = parseBillingForm(form, formData.entries());
  if (!parsed.success) back(path, tenant, "invalid");
  const actor = await actorFromSession(session);
  if (!actor) back(path, tenant, "reauth");
  const env = getWebEnv();
  let outcome: BillingOutcome;
  try {
    outcome = await call(
      {
        actor,
        meta: await requestMeta(),
        instance: env.INFRA_JOBS_INSTANCE,
        allowedTypes: instanceJobTypes(env.INFRA_JOBS_TYPES),
        // pg-boss web hanya dibuka bila aksi benar-benar meng-enqueue (tenant_resume saat tandai lunas).
        send: async (tx, id) => (await getSendFn())(tx, id),
      },
      parsed.data,
    );
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.name : "error", form }, "aksi billing gagal");
    back(path, tenant, "error");
  }
  const msg = billingLogMessage(outcome);
  if (msg) logger.error({ err: msg, form }, "aksi billing gagal");
  revalidatePath(path);
  back(path, tenant, billingOutcomeCode(outcome));
}
