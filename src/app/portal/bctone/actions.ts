"use server";

/**
 * Console BCTOne › Privasi (US-13). requirePortal("portal:admin") → Origin fail-closed → Zod strict (TANPA clientId:
 * tenant dari sesi) → portalSetAiConsent. Redirect dengan kode ter-whitelist.
 */
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { portalSetAiConsent } from "@/ai/portal-consent";
import { getDb } from "@/db";
import type { ActionResultCode } from "@/lib/job-list-params";
import { logger } from "@/lib/logger";
import { requirePermission } from "@/lib/authz";
import { requirePortal } from "@/server/portal";
import { actorFromSession, assertSameOrigin, requestMeta } from "@/server/context";

function back(code: ActionResultCode): never {
  redirect(`/portal/bctone?r=${code}`);
}

const form = z.object({ consent: z.enum(["allow", "deny"]), confirm: z.literal("on") }).strict();

export async function portalAiConsentAction(formData: FormData): Promise<void> {
  await requirePermission("users:manage_own"); // client_admin (gerbang literal, diperiksa test inventaris)
  const { session, scope } = await requirePortal("portal:admin");
  if (scope.kind !== "ok") back("forbidden");
  if (!(await assertSameOrigin())) back("origin");
  const raw = Object.fromEntries([...formData.entries()].filter(([k]) => !k.startsWith("$ACTION")));
  const parsed = form.safeParse(raw);
  if (!parsed.success) back("invalid");
  const actor = await actorFromSession(session);
  if (!actor) back("reauth");
  let code: ActionResultCode;
  try {
    const r = await portalSetAiConsent(getDb(), { clientId: scope.tenant.id, userId: scope.userId, actor, meta: await requestMeta(), consent: parsed.data.consent });
    code = r.ok ? "updated" : r.reason;
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.name : "error" }, "consent AI portal gagal");
    code = "error";
  }
  revalidatePath("/portal/bctone");
  back(code);
}
