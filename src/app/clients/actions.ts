"use server";

/**
 * Data master minimal untuk plan 05 (backfill tenant & tenant uji tanpa SQL manual): buat client dan
 * environment. Hanya superadmin (`clients:manage`). Kolom status environment TIDAK diisi dari form —
 * default `absent/none`, diperbarui dari hasil job.
 *
 * SaaS Fase 1 W5: "Tenant baru" (satu form → clients + environments + SATU rantai job), Suspend/Resume override, dan
 * "Ulangi dari langkah ini". Pola sama: requirePermission → Origin fail-closed → Zod `.strict()` → aktor → layanan
 * jobs/tenants.ts (otorisasi ulang + audit + rantai) → redirect dengan kode ter-whitelist.
 */
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@/db";
import { isUniqueViolation, safeErrorMessage } from "@/db/errors";
import { auditLogs, clients, environments, provisionJobs } from "@/db/schema";
import { getWebEnv } from "@/env";
import { requirePermission } from "@/lib/authz";
import { onboardTenant, retryChainFrom, setTenantState, tenantOutcomeCode, tenantOutcomeLog, type TenantActionOutcome } from "@/jobs/tenants";
import { defaultHost, envAllowedForInstance, instanceJobTypes, isValidHostForEnv } from "@/lib/job-contract";
import { parseForm } from "@/lib/job-forms";
import type { ActionResultCode } from "@/lib/job-list-params";
import { logger } from "@/lib/logger";
import { environmentRowValues, parseOnboardingForm, parseTenantForm } from "@/lib/tenant-onboarding";
import { getSendFn } from "@/server/boss";
import { actorFromSession, assertSameOrigin, requestMeta } from "@/server/context";

export async function createClientAction(formData: FormData): Promise<void> {
  const session = await requirePermission("clients:manage");
  if (!(await assertSameOrigin())) redirect("/clients?r=origin");
  const parsed = parseForm("createClient", formData.entries());
  if (!parsed.success) redirect("/clients?r=invalid");
  const actor = await actorFromSession(session);
  if (!actor) redirect("/clients?r=reauth");
  const meta = await requestMeta();
  let code = "created";
  try {
    await getDb().transaction(async (tx) => {
      const [row] = await tx
        .insert(clients)
        .values({ slug: parsed.data.slug, name: parsed.data.name })
        .returning({ id: clients.id });
      await tx.insert(auditLogs).values({
        actorUserId: actor.userId,
        actor: `user:${actor.sub}`,
        action: "client.create",
        targetType: "client",
        targetId: row?.id ?? null,
        clientId: row?.id ?? null,
        ip: meta.ip,
        requestId: meta.requestId,
        metadata: { slug: parsed.data.slug },
      });
    });
  } catch (err) {
    code = isUniqueViolation(err) ? "exists" : "error";
    if (code === "error") logger.error({ err: safeErrorMessage(err) }, "create client gagal");
  }
  redirect(code === "created" ? `/clients/${parsed.data.slug}?r=created` : `/clients?r=${code}`);
}

export async function createEnvironmentAction(formData: FormData): Promise<void> {
  const session = await requirePermission("clients:manage");
  if (!(await assertSameOrigin())) redirect("/clients?r=origin");
  const parsed = parseForm("createEnvironment", formData.entries());
  if (!parsed.success) redirect("/clients?r=invalid");
  const { clientId, kind, host } = parsed.data;
  const db = getDb();
  const client = (
    await db.select({ id: clients.id, slug: clients.slug, isPlatform: clients.isPlatform }).from(clients).where(eq(clients.id, clientId)).limit(1)
  )[0];
  if (!client) redirect("/clients?r=not_found");
  const slug = client.slug;
  function back(code: string): never {
    redirect(`/clients/${slug}?r=${code}`);
  }
  // Tenant internal `platform` tidak punya environment Odoo (kontrak Fase 1 §1: odoo_* dilarang untuk slug platform).
  if (client.isPlatform) back("invalid");

  const instance = getWebEnv().INFRA_JOBS_INSTANCE;
  if (instance && !envAllowedForInstance(instance, kind)) back("invalid");
  const h = host ?? defaultHost(client.slug, kind);
  if (!h || !isValidHostForEnv(h, kind)) back("invalid");
  const actor = await actorFromSession(session);
  if (!actor) back("reauth");
  const meta = await requestMeta();

  let code = "created";
  try {
    await db.transaction(async (tx) => {
      const values = environmentRowValues(client.slug, kind, h);
      const [row] = await tx
        .insert(environments)
        .values({ clientId: client.id, ...values })
        .returning({ id: environments.id });
      await tx.insert(auditLogs).values({
        actorUserId: actor.userId,
        actor: `user:${actor.sub}`,
        action: "environment.create",
        targetType: "environment",
        targetId: row?.id ?? null,
        clientId: client.id,
        ip: meta.ip,
        requestId: meta.requestId,
        metadata: { kind, db_name: values.dbName, url_host: h },
      });
    });
  } catch (err) {
    code = isUniqueViolation(err) ? "exists" : "error";
    if (code === "error") logger.error({ err: safeErrorMessage(err) }, "create environment gagal");
  }
  back(code);
}

// ---------------------------------------------------------------------------
// SaaS Fase 1 W5 — Tenant
// ---------------------------------------------------------------------------
function backTo(path: string, code: ActionResultCode, chainId?: string): never {
  const q = new URLSearchParams({ r: code });
  if (chainId) q.set("chain", chainId);
  redirect(`${path}?${q.toString()}`);
}

async function runTenant(path: string, call: () => Promise<TenantActionOutcome>): Promise<never> {
  let outcome: TenantActionOutcome;
  try {
    outcome = await call();
  } catch (err) {
    logger.error({ err: safeErrorMessage(err) }, "aksi tenant gagal");
    backTo(path, "error");
  }
  const msg = tenantOutcomeLog(outcome);
  if (msg) logger.error({ err: msg }, "aksi tenant gagal");
  revalidatePath("/clients");
  backTo(path, tenantOutcomeCode(outcome), outcome.ok ? outcome.chainId : undefined);
}

/** "Tenant baru" — satu form → tenant + environments instance ini + satu rantai onboarding (superadmin). */
export async function onboardTenantAction(formData: FormData): Promise<void> {
  const session = await requirePermission("clients:manage");
  if (!(await assertSameOrigin())) backTo("/clients", "origin");
  const env = getWebEnv();
  const instance = env.INFRA_JOBS_INSTANCE;
  if (!instance) backTo("/clients", "disabled");
  const parsed = parseOnboardingForm(instance, formData.entries());
  if (!parsed.success) backTo("/clients", parsed.issue);
  const actor = await actorFromSession(session);
  if (!actor) backTo("/clients", "reauth");
  const meta = await requestMeta();
  let outcome: TenantActionOutcome;
  try {
    outcome = await onboardTenant(getDb(), await getSendFn(), {
      instance,
      allowedTypes: instanceJobTypes(env.INFRA_JOBS_TYPES),
      actor,
      meta,
      form: parsed.data,
    });
  } catch (err) {
    logger.error({ err: safeErrorMessage(err) }, "onboarding tenant gagal");
    backTo("/clients", "error");
  }
  const msg = tenantOutcomeLog(outcome);
  if (msg) logger.error({ err: msg }, "onboarding tenant gagal");
  revalidatePath("/clients");
  if (outcome.ok) backTo(`/clients/${parsed.data.slug}`, "queued", outcome.chainId);
  backTo("/clients", tenantOutcomeCode(outcome));
}

/** Suspend/Resume override (superadmin, ketik slug) → tenant_suspend|tenant_resume per environment instance ini. */
export async function tenantStateAction(formData: FormData): Promise<void> {
  const session = await requirePermission("clients:manage");
  if (!(await assertSameOrigin())) backTo("/clients", "origin");
  const env = getWebEnv();
  const instance = env.INFRA_JOBS_INSTANCE;
  if (!instance) backTo("/clients", "disabled");
  const parsed = parseTenantForm("tenantState", formData.entries());
  if (!parsed.success) backTo("/clients", "invalid");
  const client = (await getDb().select({ slug: clients.slug }).from(clients).where(eq(clients.id, parsed.data.clientId)).limit(1))[0];
  if (!client) backTo("/clients", "not_found");
  const path = `/clients/${client.slug}`;
  const actor = await actorFromSession(session);
  if (!actor) backTo(path, "reauth");
  const meta = await requestMeta();
  await runTenant(path, async () =>
    setTenantState(getDb(), await getSendFn(), {
      instance,
      allowedTypes: instanceJobTypes(env.INFRA_JOBS_TYPES),
      actor,
      meta,
      clientId: parsed.data.clientId,
      action: parsed.data.action,
      confirm: parsed.data.confirm,
    }),
  );
}

/** "Ulangi dari langkah ini" — rantai baru dari langkah gagal (superadmin). */
export async function retryChainStepAction(formData: FormData): Promise<void> {
  const session = await requirePermission("clients:manage");
  if (!(await assertSameOrigin())) backTo("/clients", "origin");
  const env = getWebEnv();
  const instance = env.INFRA_JOBS_INSTANCE;
  if (!instance) backTo("/clients", "disabled");
  const parsed = parseForm("retry", formData.entries());
  if (!parsed.success) backTo("/clients", "invalid");
  const db = getDb();
  const owner = (
    await db
      .select({ slug: clients.slug })
      .from(provisionJobs)
      .innerJoin(clients, eq(clients.id, provisionJobs.clientId))
      .where(eq(provisionJobs.id, parsed.data.jobId))
      .limit(1)
  )[0];
  if (!owner) backTo("/clients", "not_found");
  const path = `/clients/${owner.slug}`;
  const actor = await actorFromSession(session);
  if (!actor) backTo(path, "reauth");
  const meta = await requestMeta();
  await runTenant(path, async () =>
    retryChainFrom(db, await getSendFn(), {
      instance,
      allowedTypes: instanceJobTypes(env.INFRA_JOBS_TYPES),
      actor,
      meta,
      jobId: parsed.data.jobId,
    }),
  );
}
