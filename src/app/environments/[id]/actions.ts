"use server";

/**
 * Server Actions job Odoo/SSO (plan 05 §5.1, iterasi 1: superadmin/ops). Setiap aksi:
 * requirePermission (server-side) → cek Origin fail-closed → Zod `.strict()` → layanan enqueue
 * (kontrak + otorisasi tingkat aksi + kuota + unique index + audit, satu transaksi) → redirect dengan kode
 * hasil ter-whitelist. Tidak ada eksekusi apa pun di request HTTP (ADR 0009).
 */
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@/db";
import { getWebEnv } from "@/env";
import { enqueueBridgeJob, enqueueOutcomeCode, retryBridgeJob, type EnqueueOutcome } from "@/jobs/service";
import { requirePermission } from "@/lib/authz";
import { defaultHost, type BridgeJobType } from "@/lib/job-contract";
import { parseForm, type FormName } from "@/lib/job-forms";
import type { ActionResultCode } from "@/lib/job-list-params";
import { logger } from "@/lib/logger";
import type { Permission } from "@/lib/roles";
import { getSendFn } from "@/server/boss";
import { actorFromSession, assertSameOrigin, requestMeta } from "@/server/context";
import { getEnvironment } from "@/server/queries";

type Env = NonNullable<Awaited<ReturnType<typeof getEnvironment>>>;

function back(envId: string | null, code: ActionResultCode, jobId?: string): never {
  const base = envId ? `/environments/${envId}` : "/jobs";
  const q = new URLSearchParams({ r: code });
  if (jobId) q.set("job", jobId);
  redirect(`${base}?${q.toString()}`);
}

function outcomeCode(o: EnqueueOutcome): ActionResultCode {
  return enqueueOutcomeCode(o);
}

async function runEnqueue<N extends FormName>(
  form: N,
  formData: FormData,
  permission: Permission,
  build: (
    data: Extract<ReturnType<typeof parseForm<N>>, { success: true }>["data"],
    env: Env,
  ) => { type: BridgeJobType; dryRun: boolean; args: unknown } | "confirm",
): Promise<never> {
  const session = await requirePermission(permission);
  const rawEnvId = formData.get("environmentId");
  const envIdForRedirect = typeof rawEnvId === "string" && /^[0-9a-f-]{36}$/.test(rawEnvId) ? rawEnvId : null;
  if (!(await assertSameOrigin())) back(envIdForRedirect, "origin");
  const instance = getWebEnv().INFRA_JOBS_INSTANCE;
  if (!instance) back(envIdForRedirect, "disabled");

  const parsed = parseForm(form, formData.entries());
  if (!parsed.success) back(envIdForRedirect, "invalid");
  const data = parsed.data as { environmentId: string };
  const env = await getEnvironment(data.environmentId);
  if (!env) back(null, "not_found");

  const req = build(parsed.data, env);
  if (req === "confirm") back(env.id, "confirm");

  const actor = await actorFromSession(session);
  if (!actor) back(env.id, "reauth");

  let outcome: EnqueueOutcome;
  try {
    outcome = await enqueueBridgeJob(getDb(), await getSendFn(), {
      instance,
      environmentId: env.id,
      type: req.type,
      dryRun: req.dryRun,
      args: req.args,
      actor,
      meta: await requestMeta(),
    });
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.name : "error", type: req.type }, "enqueue gagal");
    back(env.id, "error");
  }
  if (!outcome.ok && outcome.reason === "error") logger.error({ err: outcome.message, type: req.type }, "enqueue gagal");
  revalidatePath(`/environments/${env.id}`);
  back(env.id, outcomeCode(outcome), outcome.ok ? outcome.jobId : undefined);
}

export async function provisionDbAction(formData: FormData): Promise<void> {
  await runEnqueue("dbProvision", formData, "jobs:odoo", (d) => ({
    type: "odoo_db_provision",
    dryRun: false,
    args: d.host ? { host: d.host } : {},
  }));
}

export async function renderRouteAction(formData: FormData): Promise<void> {
  await runEnqueue("routeRender", formData, "jobs:odoo", (d) => ({
    type: "odoo_route",
    dryRun: false,
    args: d.host ? { host: d.host, remove: false } : { remove: false },
  }));
}

export async function removeRouteAction(formData: FormData): Promise<void> {
  await runEnqueue("routeRemove", formData, "jobs:odoo_admin", (d, env) =>
    d.confirm !== env.slug ? "confirm" : { type: "odoo_route", dryRun: false, args: { remove: true } },
  );
}

/** Host SSO diturunkan server dari environment (route aktif), bukan dari form. */
function ssoHosts(env: Env, skipSmoke: boolean): string[] {
  if (skipSmoke) {
    const d = defaultHost(env.slug, env.kind);
    return d ? [d] : [];
  }
  return env.host ? [env.host] : [];
}

export async function ssoProvisionAction(formData: FormData): Promise<void> {
  await runEnqueue("ssoProvision", formData, "jobs:odoo", (d, env) => ({
    type: "odoo_sso_provision",
    dryRun: d.dry_run,
    args: { hosts: ssoHosts(env, d.skip_smoke), rotate_secret: false, skip_smoke: d.skip_smoke },
  }));
}

export async function ssoRotateAction(formData: FormData): Promise<void> {
  await runEnqueue("ssoRotate", formData, "jobs:odoo_admin", (d, env) =>
    d.confirm !== env.slug
      ? "confirm"
      : {
          type: "odoo_sso_provision",
          dryRun: d.dry_run,
          args: { hosts: ssoHosts(env, false), rotate_secret: true, skip_smoke: false },
        },
  );
}

export async function ssoDisableAction(formData: FormData): Promise<void> {
  await runEnqueue("ssoDisable", formData, "jobs:odoo_admin", (d, env) =>
    d.confirm !== env.slug
      ? "confirm"
      : { type: "odoo_sso_disable", dryRun: d.dry_run, args: { hosts: ssoHosts(env, false) } },
  );
}

export async function ssoUserAction(formData: FormData): Promise<void> {
  await runEnqueue("ssoUser", formData, "jobs:odoo", (d) => ({
    type: "odoo_sso_user",
    dryRun: d.dry_run,
    args: {
      action: d.action,
      email: d.email,
      ...(d.login ? { login: d.login } : {}),
      // = dispatcher v_sso_user: revoke tanpa admin/create_kc, resend_invite tanpa create_kc.
      admin: d.action === "revoke" ? false : d.admin,
      create_kc: d.action === "grant" ? d.create_kc : false,
    },
  }));
}

export async function retryJobAction(formData: FormData): Promise<void> {
  const session = await requirePermission("jobs:odoo");
  if (!(await assertSameOrigin())) back(null, "origin");
  const instance = getWebEnv().INFRA_JOBS_INSTANCE;
  if (!instance) back(null, "disabled");
  const parsed = parseForm("retry", formData.entries());
  if (!parsed.success) back(null, "invalid");
  const actor = await actorFromSession(session);
  if (!actor) back(null, "reauth");
  const outcome = await retryBridgeJob(getDb(), await getSendFn(), {
    instance,
    jobId: parsed.data.jobId,
    actor,
    meta: await requestMeta(),
  });
  if (!outcome.ok && outcome.reason === "error") logger.error({ err: outcome.message }, "retry gagal");
  revalidatePath("/jobs");
  const q = new URLSearchParams({ r: outcomeCode(outcome) });
  redirect(outcome.ok ? `/jobs/${outcome.jobId}?${q.toString()}` : `/jobs/${parsed.data.jobId}?${q.toString()}`);
}
