"use server";

/**
 * Server Actions halaman Users (kontrak SaaS Fase 1 §2.3). Setiap aksi: requireAnyPermission(users:manage |
 * users:manage_own — yang terakhir default-deny untuk semua role sampai portal tenant W6, temuan QA F1.3) → Origin fail-closed → Zod `.strict()` → aktor (sub Keycloak) → layanan jobs/users.ts
 * (otorisasi tingkat aksi: tenant sendiri, role yang boleh, diri sendiri, satu admin + rantai job + audit, satu
 * transaksi) → redirect dengan kode ter-whitelist. Tidak ada eksekusi apa pun di request HTTP (ADR 0009).
 */
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@/db";
import { getWebEnv } from "@/env";
import {
  addUser,
  adoptUser,
  changeUserAccess,
  outcomeLogMessage,
  sendPasswordReset,
  setUserEnabled,
  userOutcomeCode,
  type UserActionOutcome,
  type UsersServiceInput,
} from "@/jobs/users";
import { requireAnyPermission } from "@/lib/authz";
import { instanceJobTypes } from "@/lib/job-contract";
import type { ActionResultCode } from "@/lib/job-list-params";
import { logger } from "@/lib/logger";
import { parseUserForm, type UserFormName, type UserFormResult } from "@/lib/user-forms";
import { getSendFn } from "@/server/boss";
import { actorFromSession, assertSameOrigin, requestMeta } from "@/server/context";

const BACK_RE = /^(none|[a-z0-9][a-z0-9-]{1,28}[a-z0-9])$/;

function back(tenant: string | null, code: ActionResultCode, chainId?: string): never {
  const q = new URLSearchParams();
  if (tenant) q.set("tenant", tenant);
  q.set("r", code);
  if (chainId) q.set("chain", chainId);
  redirect(`/users?${q.toString()}`);
}

/** Kerangka bersama: izin → Origin → instance → form → aktor → layanan. */
async function handle<N extends UserFormName>(
  form: N,
  formData: FormData,
  call: (svc: UsersServiceInput, parsed: Extract<UserFormResult<N>, { success: true }>) => Promise<UserActionOutcome>,
): Promise<never> {
  const session = await requireAnyPermission(["users:manage", "users:manage_own"]);
  // `back` hanya untuk redirect (slug tenant filter) — bukan bagian skema aksi.
  const rawBack = formData.get("back");
  const tenant = typeof rawBack === "string" && BACK_RE.test(rawBack) ? rawBack : null;
  formData.delete("back");
  if (!(await assertSameOrigin())) back(tenant, "origin");
  const env = getWebEnv();
  const instance = env.INFRA_JOBS_INSTANCE;
  if (!instance) back(tenant, "disabled");
  const parsed = parseUserForm(form, formData.entries());
  if (!parsed.success) back(tenant, parsed.issue);
  const actor = await actorFromSession(session);
  if (!actor) back(tenant, "reauth");

  let outcome: UserActionOutcome;
  try {
    outcome = await call(
      { instance, allowedTypes: instanceJobTypes(env.INFRA_JOBS_TYPES), actor, meta: await requestMeta() },
      parsed as Extract<UserFormResult<N>, { success: true }>,
    );
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.name : "error", form }, "aksi user gagal");
    back(tenant, "error");
  }
  const msg = outcomeLogMessage(outcome);
  if (msg) logger.error({ err: msg, form }, "aksi user gagal");
  revalidatePath("/users");
  back(tenant, userOutcomeCode(outcome), outcome.ok ? outcome.chainId : undefined);
}

export async function addUserAction(formData: FormData): Promise<void> {
  await handle("addUser", formData, async (svc, p) =>
    addUser(getDb(), await getSendFn(), {
      ...svc,
      clientId: p.data.clientId,
      email: p.data.email,
      name: p.data.name ?? null,
      cpRole: p.data.cp_role,
      odoo: p.odoo,
    }),
  );
}

export async function changeUserAccessAction(formData: FormData): Promise<void> {
  await handle("changeAccess", formData, async (svc, p) =>
    changeUserAccess(getDb(), await getSendFn(), { ...svc, userId: p.data.userId, cpRole: p.data.cp_role, odoo: p.odoo }),
  );
}

export async function disableUserAction(formData: FormData): Promise<void> {
  await handle("disableUser", formData, async (svc, p) =>
    setUserEnabled(getDb(), await getSendFn(), { ...svc, userId: p.data.userId, enabled: false }),
  );
}

export async function enableUserAction(formData: FormData): Promise<void> {
  await handle("enableUser", formData, async (svc, p) =>
    setUserEnabled(getDb(), await getSendFn(), { ...svc, userId: p.data.userId, enabled: true, odoo: p.odoo }),
  );
}

export async function adoptUserAction(formData: FormData): Promise<void> {
  await handle("adoptUser", formData, async (svc, p) =>
    adoptUser(getDb(), await getSendFn(), { ...svc, userId: p.data.userId, clientId: p.data.clientId, cpRole: p.data.cp_role }),
  );
}

export async function passwordResetAction(formData: FormData): Promise<void> {
  await handle("passwordReset", formData, async (svc, p) =>
    sendPasswordReset(getDb(), await getSendFn(), { ...svc, userId: p.data.userId }),
  );
}
