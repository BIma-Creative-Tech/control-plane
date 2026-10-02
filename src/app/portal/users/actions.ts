"use server";

/**
 * Server Actions portal tenant `/portal/users` (W6). Setiap aksi: requirePermission(users:manage_own = client_admin)
 * → Origin fail-closed → Zod `.strict()` (TANPA clientId/cp_role — tenant & role ditentukan server) → aktor (sub
 * Keycloak) → layanan jobs/portal.ts (kanal portal: cakupan tenant sendiri, client_user saja, aturan F1, batas plan) →
 * redirect dengan kode ter-whitelist. Tidak ada eksekusi apa pun di request HTTP (ADR 0009).
 */
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@/db";
import { getWebEnv } from "@/env";
import { portalAddUser, portalChangeAccess, portalOutcomeCode, portalPasswordReset, portalSetUserEnabled } from "@/jobs/portal";
import { outcomeLogMessage, type UserActionOutcome, type UsersServiceInput } from "@/jobs/users";
import { requirePermission } from "@/lib/authz";
import { instanceJobTypes } from "@/lib/job-contract";
import type { ActionResultCode } from "@/lib/job-list-params";
import { logger } from "@/lib/logger";
import { parseUserForm, type UserFormName, type UserFormResult } from "@/lib/user-forms";
import { getSendFn } from "@/server/boss";
import { actorFromSession, assertSameOrigin, requestMeta } from "@/server/context";

function back(code: ActionResultCode): never {
  redirect(`/portal/users?r=${code}`);
}

type PortalForm = Extract<UserFormName, "portalAddUser" | "portalChangeAccess" | "disableUser" | "enableUser" | "passwordReset">;

async function handle<N extends PortalForm>(
  form: N,
  formData: FormData,
  call: (svc: Omit<UsersServiceInput, "channel">, parsed: Extract<UserFormResult<N>, { success: true }>) => Promise<UserActionOutcome>,
): Promise<never> {
  const session = await requirePermission("users:manage_own");
  if (!(await assertSameOrigin())) back("origin");
  const env = getWebEnv();
  const instance = env.INFRA_JOBS_INSTANCE;
  if (!instance) back("disabled");
  const parsed = parseUserForm(form, formData.entries());
  if (!parsed.success) back(parsed.issue);
  const actor = await actorFromSession(session);
  if (!actor) back("reauth");
  let outcome: UserActionOutcome;
  try {
    outcome = await call(
      { instance, allowedTypes: instanceJobTypes(env.INFRA_JOBS_TYPES), actor, meta: await requestMeta() },
      parsed as Extract<UserFormResult<N>, { success: true }>,
    );
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.name : "error", form }, "aksi portal user gagal");
    back("error");
  }
  const msg = outcomeLogMessage(outcome);
  if (msg) logger.error({ err: msg, form }, "aksi portal user gagal");
  revalidatePath("/portal/users");
  back(portalOutcomeCode(outcome));
}

export async function portalAddUserAction(formData: FormData): Promise<void> {
  await handle("portalAddUser", formData, async (svc, p) =>
    portalAddUser(getDb(), await getSendFn(), { ...svc, email: p.data.email, name: p.data.name ?? null, odoo: p.odoo }),
  );
}

export async function portalChangeAccessAction(formData: FormData): Promise<void> {
  await handle("portalChangeAccess", formData, async (svc, p) => portalChangeAccess(getDb(), await getSendFn(), { ...svc, userId: p.data.userId, odoo: p.odoo }));
}

export async function portalDisableUserAction(formData: FormData): Promise<void> {
  await handle("disableUser", formData, async (svc, p) => portalSetUserEnabled(getDb(), await getSendFn(), { ...svc, userId: p.data.userId, enabled: false }));
}

export async function portalEnableUserAction(formData: FormData): Promise<void> {
  await handle("enableUser", formData, async (svc, p) =>
    portalSetUserEnabled(getDb(), await getSendFn(), { ...svc, userId: p.data.userId, enabled: true, odoo: p.odoo }),
  );
}

export async function portalPasswordResetAction(formData: FormData): Promise<void> {
  await handle("passwordReset", formData, async (svc, p) => portalPasswordReset(getDb(), await getSendFn(), { ...svc, userId: p.data.userId }));
}
