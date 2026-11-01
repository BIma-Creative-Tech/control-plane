"use server";

/**
 * Console › Tagihan: tenant-admin melaporkan pembayaran manual. requirePermission(users:manage_own = client_admin) +
 * requirePortal("portal:admin") → Origin → Zod strict (tenant dari sesi) → portalReportPayment.
 */
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { portalReportPayment, reportPaymentSchema } from "@/billing/portal-payment";
import { getDb } from "@/db";
import { requirePermission } from "@/lib/authz";
import { formToObject } from "@/lib/job-forms";
import type { ActionResultCode } from "@/lib/job-list-params";
import { logger } from "@/lib/logger";
import { requirePortal } from "@/server/portal";
import { actorFromSession, assertSameOrigin, requestMeta } from "@/server/context";

function back(code: ActionResultCode): never {
  redirect(`/portal/billing?r=${code}`);
}

export async function portalReportPaymentAction(formData: FormData): Promise<void> {
  await requirePermission("users:manage_own");
  const { session, scope } = await requirePortal("portal:admin");
  if (scope.kind !== "ok") back("forbidden");
  if (!(await assertSameOrigin())) back("origin");
  const parsed = reportPaymentSchema.safeParse(formToObject(formData.entries()) ?? {});
  if (!parsed.success) back("invalid");
  const actor = await actorFromSession(session);
  if (!actor) back("reauth");
  let code: ActionResultCode;
  try {
    const r = await portalReportPayment(getDb(), { clientId: scope.tenant.id, userId: scope.userId, actor, meta: await requestMeta(), form: parsed.data });
    code = r.ok ? "payment_reported" : r.reason;
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.name : "error" }, "lapor pembayaran gagal");
    code = "error";
  }
  revalidatePath("/portal/billing");
  back(code);
}
