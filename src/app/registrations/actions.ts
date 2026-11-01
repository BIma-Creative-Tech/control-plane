"use server";

/** BCT Admin › Registrasi BCTOne: setujui (provision) atau tolak registrasi review/waitlist. superadmin (`clients:manage`). */
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { provisionRegistration, rejectRegistration } from "@/bctone/registration";
import { getDb } from "@/db";
import { getWebEnv } from "@/env";
import { requirePermission } from "@/lib/authz";
import { formToObject } from "@/lib/job-forms";
import { instanceJobTypes } from "@/lib/job-contract";
import type { ActionResultCode } from "@/lib/job-list-params";
import { logger } from "@/lib/logger";
import { getSendFn } from "@/server/boss";
import { actorFromSession, assertSameOrigin, requestMeta } from "@/server/context";

function back(code: ActionResultCode): never {
  redirect(`/registrations?r=${code}`);
}

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

export async function approveRegistrationAction(formData: FormData): Promise<void> {
  const session = await requirePermission("clients:manage");
  if (!(await assertSameOrigin())) back("origin");
  const p = z.object({ id: uuid }).strict().safeParse(formToObject(formData.entries()) ?? {});
  if (!p.success) back("invalid");
  const actor = await actorFromSession(session);
  if (!actor) back("reauth");
  const env = getWebEnv();
  let code: ActionResultCode = "queued";
  try {
    const r = await provisionRegistration(
      getDb(),
      p.data.id,
      { instance: env.INFRA_JOBS_INSTANCE, allowedTypes: instanceJobTypes(env.INFRA_JOBS_TYPES), capacity: env.BCTONE_CAPACITY, send: await getSendFn(), meta: await requestMeta() },
      actor,
    );
    if (!r.ok) {
      logger.warn({ detail: r.detail }, "provision registrasi gagal");
      code = r.detail === "state" ? "precondition" : "error";
    }
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.name : "error" }, "approve registrasi gagal");
    code = "error";
  }
  revalidatePath("/registrations");
  back(code);
}

export async function rejectRegistrationAction(formData: FormData): Promise<void> {
  await requirePermission("clients:manage");
  if (!(await assertSameOrigin())) back("origin");
  const p = z
    .object({ id: uuid, note: z.string().trim().min(3).max(500) })
    .strict()
    .safeParse(formToObject(formData.entries()) ?? {});
  if (!p.success) back("invalid");
  const ok = await rejectRegistration(getDb(), p.data.id, p.data.note, await requestMeta());
  revalidatePath("/registrations");
  back(ok ? "updated" : "precondition");
}
