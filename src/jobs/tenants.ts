/**
 * Layanan Tenant (SaaS Fase 1 W5): onboarding satu form, Suspend/Resume override, ulangi rantai dari langkah gagal,
 * dan sync realm. Setiap aksi: otorisasi tingkat layanan (bukan hanya tombol UI) → aturan data (email F1, host,
 * konfirmasi) → enqueueChain (satu transaksi: prelude DB + job + audit + outbox). Penolakan diaudit
 * `result=rejected`; email tidak pernah masuk audit (hanya email_hash). Tidak ada eksekusi di request HTTP (ADR 0009).
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { isUniqueViolation, safeErrorMessage } from "../db/errors";
import { auditLogs, clients, environments, provisionJobs, users } from "../db/schema";
import {
  emailHash,
  envAllowedForInstance,
  realmEnvForInstance,
  type BridgeJobType,
  type Instance,
  type TenantEnv,
} from "../lib/job-contract";
import type { ActionResultCode } from "../lib/job-list-params";
import { can, type Permission } from "../lib/roles";
import {
  ONBOARDING_TYPES,
  REALM_SYNC_TYPES,
  TENANT_STATE_TYPES,
  buildOnboardingSteps,
  buildTenantStateSteps,
  confirmMatches,
  decideRealmSync,
  environmentRowValues,
  realmNameForEnv,
  retryStepsFrom,
  retryableOrigin,
  typesEnabled,
  type OnboardingInput,
  type RetryIssue,
  type TenantStateAction,
} from "../lib/tenant-onboarding";
import {
  buildRegisterExistingSteps,
  registerAuditMetadata,
  registeredEnvironmentRowValues,
  validateRegisterInput,
  type RegisterExistingInput,
  type RegisterFormIssue,
} from "../lib/tenant-register";
import { emailBindingConflict, orderChain, type EmailBindingConflict, type TenantRef } from "../lib/user-admin";
import { BillingAbort, createSubscriptionTx } from "../billing/service";
import { ChainAbort, enqueueChain, type ChainFailure, type ChainInput } from "./chain";
import type { Actor, RequestMeta, SendFn, Tx } from "./service";

export interface TenantServiceInput {
  instance: Instance;
  allowedTypes: readonly BridgeJobType[];
  actor: Actor;
  meta: RequestMeta;
}

export type TenantActionFailure =
  | { reason: "forbidden" }
  | { reason: "disabled" }
  | { reason: "not_found" }
  | { reason: "confirm" }
  | { reason: "tenant_inactive" }
  | { reason: "retry"; issue: RetryIssue }
  | { reason: "binding"; conflict: EmailBindingConflict }
  | { reason: "realm"; code: "approve_required" | "plan_required" }
  /** Pendaftaran tenant lama: input ditolak aturan (slug platform, konvensi db_name, host). */
  | { reason: "register"; issue: Exclude<RegisterFormIssue, "no_env"> }
  | ChainFailure;

export type TenantActionOutcome = { ok: true; chainId: string; jobIds: string[]; clientId: string } | ({ ok: false } & TenantActionFailure);

async function actorDisabled(db: Db, actor: Actor): Promise<boolean> {
  if (!actor.userId) return false;
  const row = (await db.select({ status: users.status }).from(users).where(eq(users.id, actor.userId)).limit(1))[0];
  return row?.status === "disabled";
}

async function auditRejected(
  db: Db,
  input: TenantServiceInput,
  action: string,
  clientId: string | null,
  md: Record<string, unknown>,
): Promise<void> {
  try {
    await db.insert(auditLogs).values({
      actorUserId: input.actor.userId,
      actor: `user:${input.actor.sub}`,
      action,
      targetType: "client",
      targetId: clientId,
      clientId,
      result: "rejected",
      ip: input.meta.ip,
      requestId: input.meta.requestId,
      metadata: md,
    });
  } catch {
    // diabaikan: penolakan tetap dikembalikan
  }
}

/** Gerbang izin layanan (pertahanan berlapis di bawah requirePermission Server Action). */
async function gate(db: Db, input: TenantServiceInput, permission: Permission, action: string, clientId: string | null, md: Record<string, unknown>) {
  if (!can(input.actor.roles, permission) || (await actorDisabled(db, input.actor))) {
    await auditRejected(db, input, action, clientId, { ...md, reason: "forbidden" });
    return false;
  }
  return true;
}

async function usersByEmail(db: Db, email: string) {
  return db
    .select({ id: users.id, clientId: users.clientId, role: users.role })
    .from(users)
    .where(sql`lower(${users.email}) = ${email.toLowerCase()}`)
    .limit(20);
}

// ---------------------------------------------------------------------------
// Onboarding
// ---------------------------------------------------------------------------
/**
 * Tenant baru: SATU transaksi = INSERT clients + environments + audit `tenant.create` (+ langganan `implementation`
 * bila plan dipilih) (prelude) + rantai job +
 * audit `tenant.onboard` + pesan pg-boss kepala rantai. Ditolak (slug/DB/host terpakai, kuota, email F1) → tidak ada
 * baris yang tertinggal.
 */
export async function onboardTenant(db: Db, send: SendFn, input: TenantServiceInput & { form: OnboardingInput }): Promise<TenantActionOutcome> {
  const f = input.form;
  const md = { slug: f.slug, envs: f.envs.map((e) => e.kind), email_hash: emailHash(f.adminEmail), ...(f.planId ? { plan_id: f.planId } : {}) };
  if (!(await gate(db, input, "clients:manage", "tenant.onboard", null, md))) return { ok: false, reason: "forbidden" };
  // Langganan saat onboarding = aksi billing → izin billing:manage juga (superadmin).
  if (f.planId && !(await gate(db, input, "billing:manage", "tenant.onboard", null, md))) return { ok: false, reason: "forbidden" };
  if (!typesEnabled(input.allowedTypes, ONBOARDING_TYPES)) return { ok: false, reason: "disabled" };
  if (f.envs.length === 0 || f.envs.some((e) => !envAllowedForInstance(input.instance, e.kind))) {
    return { ok: false, reason: "precondition", detail: "no_env" };
  }
  const tenantId = randomUUID();
  const tenant: TenantRef = { id: tenantId, slug: f.slug, isPlatform: false, terminated: false };
  // F1.2: tenant baru → SETIAP baris users dengan email ini milik tenant lain / lama tanpa tenant / platform.
  const conflict = emailBindingConflict(tenant, await usersByEmail(db, f.adminEmail));
  if (conflict) {
    await auditRejected(db, input, "tenant.onboard", null, { ...md, reason: "binding", conflict });
    return { ok: false, reason: "binding", conflict };
  }
  const actorLabel = `user:${input.actor.sub}`;
  const hosts = f.envs.map((e) => e.host);
  const urls = hosts.map((h) => `https://${h}`);

  const prelude = async (tx: Tx) => {
    // Host dipakai environment lain (route tenant lain) → tolak; dispatcher juga menolak, ini umpan balik awal.
    const taken = await tx
      .select({ id: environments.id })
      .from(environments)
      .where(or(inArray(environments.host, hosts), inArray(environments.url, urls)))
      .limit(1);
    if (taken.length > 0) throw new ChainAbort({ reason: "precondition", detail: "host_taken" });
    const ins = await tx
      .insert(clients)
      .values({ id: tenantId, slug: f.slug, name: f.name, brand: f.brand })
      .onConflictDoNothing()
      .returning({ id: clients.id });
    if (ins.length === 0) throw new ChainAbort({ reason: "exists" });
    const envRows = await tx
      .insert(environments)
      .values(f.envs.map((e) => ({ clientId: tenantId, ...environmentRowValues(f.slug, e.kind, e.host) })))
      .onConflictDoNothing()
      .returning({ id: environments.id, kind: environments.kind });
    if (envRows.length !== f.envs.length) throw new ChainAbort({ reason: "exists" });
    await tx.insert(auditLogs).values({
      actorUserId: input.actor.userId,
      actor: actorLabel,
      action: "tenant.create",
      targetType: "client",
      targetId: tenantId,
      clientId: tenantId,
      ip: input.meta.ip,
      requestId: input.meta.requestId,
      metadata: {
        slug: f.slug,
        brand: f.brand,
        environments: envRows.map((r) => ({ id: r.id, kind: r.kind })),
        hosts,
      },
    });
    // Integrasi Fase 1: plan Odoo opsional → langganan `implementation` di transaksi yang sama (audit subscription.create).
    if (f.planId) {
      try {
        await createSubscriptionTx(tx, input, { clientId: tenantId, planId: f.planId, requireService: "odoo" });
      } catch (err) {
        if (err instanceof BillingAbort) throw new ChainAbort({ reason: "precondition", detail: "plan_inactive" });
        throw err;
      }
    }
  };

  const out = await enqueueChain(db, send, {
    instance: input.instance,
    allowedTypes: input.allowedTypes,
    client: { id: tenantId, slug: f.slug, isNew: true },
    steps: buildOnboardingSteps({ tenantId, realmEnv: realmEnvForInstance(input.instance), envs: f.envs, adminEmail: f.adminEmail, adminName: f.adminName }),
    actor: input.actor,
    meta: input.meta,
    audit: { action: "tenant.onboard", targetType: "client", targetId: tenantId, metadata: { ...md, tenant_check: "compat" } },
    prelude,
  });
  if (!out.ok) return out;
  return { ok: true, chainId: out.chainId, jobIds: out.jobIds, clientId: tenantId };
}

// ---------------------------------------------------------------------------
// Daftarkan tenant yang sudah ada (migrasi prod M8)
// ---------------------------------------------------------------------------
export type RegisterOutcome =
  | { ok: true; clientId: string; chainId: string | null; jobIds: string[]; skipped: BridgeJobType[] }
  | ({ ok: false } & TenantActionFailure);

/**
 * Tenant yang SUDAH hidup (DB, route — boleh host kustom —, SSO) dicatat tanpa provisioning: SATU transaksi = INSERT
 * clients + environments (status = deklarasi) (+ langganan `implementation` bila plan dipilih) + audit
 * `tenant.register_existing` + rantai `kc_org_ensure` [+ `odoo_tenant_config(compat)` per env ber-SSO aktif] + pesan
 * pg-boss kepala rantai. Tipe di luar allowlist instance dilewati; tidak ada yang diizinkan → baris DB + audit saja.
 * Superadmin (`clients:manage`; plan → juga `billing:manage`). Ditolak (slug/DB/host terpakai, kuota) → tidak ada baris
 * yang tertinggal; penolakan diaudit `result=rejected`.
 */
export async function registerExistingTenant(
  db: Db,
  send: SendFn,
  input: TenantServiceInput & { form: RegisterExistingInput; platformDomains?: readonly string[] },
): Promise<RegisterOutcome> {
  const f = input.form;
  const action = "tenant.register_existing";
  const md = registerAuditMetadata(f);
  if (!(await gate(db, input, "clients:manage", action, null, md))) return { ok: false, reason: "forbidden" };
  if (f.planId && !(await gate(db, input, "billing:manage", action, null, md))) return { ok: false, reason: "forbidden" };
  // Pertahanan berlapis: aturan form diulang di layanan (slug platform, konvensi db_name, host, env instance).
  const issue = validateRegisterInput(input.instance, f, input.platformDomains);
  if (issue) {
    await auditRejected(db, input, action, null, { ...md, reason: "invalid", issue });
    if (issue === "no_env") return { ok: false, reason: "precondition", detail: "no_env" };
    return { ok: false, reason: "register", issue };
  }
  const tenantId = randomUUID();
  const hosts = f.envs.map((e) => e.host);
  const urls = hosts.map((h) => `https://${h}`);
  const { steps, skipped } = buildRegisterExistingSteps({
    tenantId,
    realmEnv: realmEnvForInstance(input.instance),
    envs: f.envs,
    allowedTypes: input.allowedTypes,
  });
  const auditMd = { ...md, ...(skipped.length > 0 ? { skipped_types: skipped } : {}) };

  const prelude = async (tx: Tx) => {
    const taken = await tx
      .select({ id: environments.id })
      .from(environments)
      .where(or(inArray(environments.host, hosts), inArray(environments.url, urls)))
      .limit(1);
    if (taken.length > 0) throw new ChainAbort({ reason: "precondition", detail: "host_taken" });
    const ins = await tx
      .insert(clients)
      .values({ id: tenantId, slug: f.slug, name: f.name, brand: f.brand })
      .onConflictDoNothing()
      .returning({ id: clients.id });
    if (ins.length === 0) throw new ChainAbort({ reason: "exists" });
    const envRows = await tx
      .insert(environments)
      .values(f.envs.map((e) => ({ clientId: tenantId, ...registeredEnvironmentRowValues(e) })))
      .onConflictDoNothing()
      .returning({ id: environments.id });
    // db_name unik global (environments_db_name_uq): DB sudah tercatat untuk tenant lain → tolak utuh.
    if (envRows.length !== f.envs.length) throw new ChainAbort({ reason: "exists" });
    if (f.planId) {
      try {
        await createSubscriptionTx(tx, input, { clientId: tenantId, planId: f.planId, requireService: "odoo" });
      } catch (err) {
        if (err instanceof BillingAbort) throw new ChainAbort({ reason: "precondition", detail: "plan_inactive" });
        throw err;
      }
    }
  };

  if (steps.length > 0) {
    const out = await enqueueChain(db, send, {
      instance: input.instance,
      allowedTypes: input.allowedTypes,
      client: { id: tenantId, slug: f.slug, isNew: true },
      steps,
      actor: input.actor,
      meta: input.meta,
      audit: { action, targetType: "client", targetId: tenantId, metadata: auditMd },
      prelude,
    });
    if (!out.ok) return out;
    return { ok: true, clientId: tenantId, chainId: out.chainId, jobIds: out.jobIds, skipped };
  }

  // Tidak ada tipe job yang diizinkan instance ini → baris DB + audit saja (transaksi yang sama).
  try {
    await db.transaction(async (tx) => {
      await prelude(tx);
      await tx.insert(auditLogs).values({
        actorUserId: input.actor.userId,
        actor: `user:${input.actor.sub}`,
        action,
        targetType: "client",
        targetId: tenantId,
        clientId: tenantId,
        result: "success",
        ip: input.meta.ip,
        requestId: input.meta.requestId,
        metadata: { ...auditMd, steps: [] },
      });
    });
  } catch (err) {
    let failure: TenantActionFailure;
    if (err instanceof ChainAbort) failure = err.failure;
    else if (isUniqueViolation(err)) failure = { reason: "exists" };
    else return { ok: false, reason: "error", message: safeErrorMessage(err) };
    await auditRejected(db, input, action, null, { ...auditMd, reason: failure.reason, ...("detail" in failure ? { detail: failure.detail } : {}) });
    return { ok: false, ...failure };
  }
  return { ok: true, clientId: tenantId, chainId: null, jobIds: [], skipped };
}

/** Kode `?r=` hasil pendaftaran (murni): rantai penuh → queued; sebagian/tanpa job (allowlist) → pemberitahuan. */
export function registerOutcomeCode(o: RegisterOutcome): ActionResultCode {
  if (!o.ok) return tenantOutcomeCode(o);
  if (o.chainId === null) return "registered_no_jobs";
  return o.skipped.length > 0 ? "registered_partial" : "queued";
}

// ---------------------------------------------------------------------------
// Muat tenant
// ---------------------------------------------------------------------------
async function loadTenant(db: Db, clientId: string) {
  return (
    await db
      .select({ id: clients.id, slug: clients.slug, isPlatform: clients.isPlatform, terminatedAt: clients.terminatedAt })
      .from(clients)
      .where(eq(clients.id, clientId))
      .limit(1)
  )[0];
}

// ---------------------------------------------------------------------------
// Suspend / Resume override
// ---------------------------------------------------------------------------
/**
 * Override manual platform-admin: `tenant_suspend|tenant_resume` untuk setiap environment tenant di instance ini
 * (satu rantai). Konfirmasi = ketik slug. Di transaksi enqueue: kunci per tenant + tolak bila aksi KEBALIKANNYA masih
 * aktif (`state_busy`); aksi yang sama aktif → dipakai ulang lewat idempotency_key. `clients.status` TIDAK diubah di sini
 * (rekonsiliasi RESULT tenant_suspend/resume = pekerjaan billing/W7).
 */
export async function setTenantState(
  db: Db,
  send: SendFn,
  input: TenantServiceInput & { clientId: string; action: TenantStateAction; confirm: string | null },
): Promise<TenantActionOutcome> {
  const auditAction = `tenant.${input.action}`;
  const t = await loadTenant(db, input.clientId);
  if (!t) return { ok: false, reason: "not_found" };
  const md = { slug: t.slug, override: true };
  if (!(await gate(db, input, "clients:manage", auditAction, t.id, md))) return { ok: false, reason: "forbidden" };
  if (!typesEnabled(input.allowedTypes, TENANT_STATE_TYPES)) return { ok: false, reason: "disabled" };
  if (t.isPlatform) {
    await auditRejected(db, input, auditAction, t.id, { ...md, reason: "platform" });
    return { ok: false, reason: "invalid", issue: "platform_forbidden", step: 0 };
  }
  if (t.terminatedAt) return { ok: false, reason: "tenant_inactive" };
  if (!confirmMatches(input.confirm, t.slug)) {
    await auditRejected(db, input, auditAction, t.id, { ...md, reason: "confirm" });
    return { ok: false, reason: "confirm" };
  }
  const envRows = await db.select({ kind: environments.kind }).from(environments).where(eq(environments.clientId, t.id)).orderBy(environments.kind);
  const envs = envRows.filter((e) => envAllowedForInstance(input.instance, e.kind as TenantEnv)) as { kind: TenantEnv }[];
  if (envs.length === 0) {
    await auditRejected(db, input, auditAction, t.id, { ...md, reason: "no_env" });
    return { ok: false, reason: "precondition", detail: "no_env" };
  }
  const opposite: BridgeJobType = input.action === "suspend" ? "tenant_resume" : "tenant_suspend";
  const prelude = async (tx: Tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`tenant-state:${t.id}`}))`);
    const busy = await tx
      .select({ id: provisionJobs.id })
      .from(provisionJobs)
      .where(and(eq(provisionJobs.clientId, t.id), eq(provisionJobs.type, opposite), inArray(provisionJobs.status, ["queued", "dispatched", "running"])))
      .limit(1);
    if (busy.length > 0) throw new ChainAbort({ reason: "precondition", detail: "state_busy" });
  };
  const out = await enqueueChain(db, send, {
    instance: input.instance,
    allowedTypes: input.allowedTypes,
    client: { id: t.id, slug: t.slug },
    steps: buildTenantStateSteps(input.action, envs),
    actor: input.actor,
    meta: input.meta,
    audit: { action: auditAction, targetType: "client", targetId: t.id, metadata: { ...md, envs: envs.map((e) => e.kind) } },
    prelude,
  });
  if (!out.ok) return out;
  return { ok: true, chainId: out.chainId, jobIds: out.jobIds, clientId: t.id };
}

// ---------------------------------------------------------------------------
// Ulangi dari langkah gagal
// ---------------------------------------------------------------------------
/** Aksi audit (sukses) yang membuat rantai — `metadata.chain_id`, dibatasi tenant (indeks audit_logs_client_idx). */
export async function chainOrigin(db: Db, clientId: string, chainId: string): Promise<string | null> {
  const row = (
    await db
      .select({ action: auditLogs.action })
      .from(auditLogs)
      .where(and(eq(auditLogs.clientId, clientId), eq(auditLogs.result, "success"), sql`${auditLogs.metadata} ->> 'chain_id' = ${chainId}`))
      .limit(1)
  )[0];
  return row?.action ?? null;
}

/**
 * Rantai BARU dari langkah gagal (`jobId`) sampai akhir rantai lama, args sama (validasi ulang kontrak + aturan email
 * F1 + satu admin + kuota di enqueueChain). Superadmin (`clients:manage`). Kepala rantai baru: parent_job_id = jobId.
 */
export async function retryChainFrom(db: Db, send: SendFn, input: TenantServiceInput & { jobId: string }): Promise<TenantActionOutcome> {
  const job = (
    await db
      .select({ id: provisionJobs.id, chainId: provisionJobs.chainId, clientId: provisionJobs.clientId })
      .from(provisionJobs)
      .where(eq(provisionJobs.id, input.jobId))
      .limit(1)
  )[0];
  if (!job || !job.chainId || !job.clientId) return { ok: false, reason: "not_found" };
  const t = await loadTenant(db, job.clientId);
  if (!t) return { ok: false, reason: "not_found" };
  const md = { slug: t.slug, from_job_id: job.id, from_chain_id: job.chainId };
  if (!(await gate(db, input, "clients:manage", "chain.retry", t.id, md))) return { ok: false, reason: "forbidden" };
  if (t.terminatedAt) return { ok: false, reason: "tenant_inactive" };

  const rows = await db
    .select({
      id: provisionJobs.id,
      type: provisionJobs.type,
      env: provisionJobs.env,
      status: provisionJobs.status,
      errorCode: provisionJobs.errorCode,
      dryRun: provisionJobs.dryRun,
      afterJobId: provisionJobs.afterJobId,
      createdAt: provisionJobs.createdAt,
      payload: provisionJobs.payload,
    })
    .from(provisionJobs)
    .where(eq(provisionJobs.chainId, job.chainId))
    .limit(64);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const ordered = orderChain(
    rows.map((r) => ({ id: r.id, type: r.type, env: r.env, status: r.status, errorCode: r.errorCode, afterJobId: r.afterJobId, createdAt: r.createdAt, email: null, slug: t.slug })),
  ).map((o) => {
    const r = byId.get(o.id)!;
    return { id: r.id, type: r.type, env: r.env, status: r.status, errorCode: r.errorCode, dryRun: r.dryRun, args: ((r.payload as { args?: Record<string, unknown> }).args ?? {}) as Record<string, unknown> };
  });
  const rejectRetry = async (issue: RetryIssue): Promise<TenantActionOutcome> => {
    await auditRejected(db, input, "chain.retry", t.id, { ...md, reason: "retry", issue });
    return { ok: false, reason: "retry", issue };
  };
  // Hanya rantai aksi tenant/realm (asal = audit sukses dengan metadata.chain_id rantai ini, tenant yang sama).
  if (!retryableOrigin(await chainOrigin(db, t.id, job.chainId))) return rejectRetry("origin");
  const plan = retryStepsFrom(ordered, job.id);
  if (!plan.ok) return rejectRetry(plan.issue);
  // F1.2 untuk setiap email di langkah yang diulang (baris tenant ini sendiri tidak konflik).
  const ref: TenantRef = { id: t.id, slug: t.slug, isPlatform: t.isPlatform, terminated: false };
  const emails = [...new Set(plan.steps.map((s) => s.args.email).filter((e): e is string => typeof e === "string"))];
  const actorEmail = input.actor.userId
    ? ((await db.select({ email: users.email }).from(users).where(eq(users.id, input.actor.userId)).limit(1))[0]?.email ?? null)
    : null;
  for (const e of emails) {
    if (actorEmail && actorEmail.toLowerCase() === e.toLowerCase()) return rejectRetry("self_target");
    const own = await db
      .select({ status: users.status })
      .from(users)
      .where(and(eq(users.clientId, t.id), sql`lower(${users.email}) = ${e.toLowerCase()}`))
      .limit(5);
    if (own.some((u) => u.status === "disabled")) return rejectRetry("target_disabled");
    const adoptRow = plan.steps.some((s) => s.type === "kc_user_ensure" && s.args.email === e && s.args.adopt === true);
    const rowsE = await usersByEmail(db, e);
    // Adopt: baris lama client_id NULL = target adopt itu sendiri (dikecualikan, sama dengan adoptUser).
    const exclude = adoptRow ? (rowsE.find((r) => r.clientId === null)?.id ?? null) : null;
    const conflict = emailBindingConflict(ref, rowsE, exclude);
    if (conflict) {
      await auditRejected(db, input, "chain.retry", t.id, { ...md, reason: "binding", conflict, email_hash: emailHash(e) });
      return { ok: false, reason: "binding", conflict };
    }
  }
  const chainInput: ChainInput = {
    instance: input.instance,
    allowedTypes: input.allowedTypes,
    client: { id: t.id, slug: t.slug },
    steps: plan.steps,
    actor: input.actor,
    meta: input.meta,
    audit: { action: "chain.retry", targetType: "client", targetId: t.id, metadata: md },
    retryOf: job.id,
  };
  const out = await enqueueChain(db, send, chainInput);
  if (!out.ok) return out;
  return { ok: true, chainId: out.chainId, jobIds: out.jobIds, clientId: t.id };
}

// ---------------------------------------------------------------------------
// kc_realm_sync
// ---------------------------------------------------------------------------
export async function platformTenant(db: Db) {
  return (await db.select({ id: clients.id, slug: clients.slug }).from(clients).where(eq(clients.isPlatform, true)).limit(1))[0] ?? null;
}

/** Rencana (dry-run) kc_realm_sync terakhir untuk env realm instance ini. */
export async function lastRealmPlan(db: Db, platformId: string, realmEnv: TenantEnv) {
  return (
    (
      await db
        .select({ status: provisionJobs.status, finishedAt: provisionJobs.finishedAt, result: provisionJobs.result })
        .from(provisionJobs)
        .where(
          and(
            eq(provisionJobs.clientId, platformId),
            eq(provisionJobs.type, "kc_realm_sync"),
            eq(provisionJobs.env, realmEnv),
            eq(provisionJobs.dryRun, true),
          ),
        )
        .orderBy(desc(provisionJobs.createdAt))
        .limit(1)
    )[0] ?? null
  );
}

/**
 * "Rencana sync realm" (dry-run) / "Terapkan" (apply, ketik nama realm; prod/demo + checkbox → approve=true).
 * Permission `realm:sync` (superadmin). Slug selalu `platform`, env = env realm instance (prod-inst → prod).
 */
export async function requestRealmSync(
  db: Db,
  send: SendFn,
  input: TenantServiceInput & { mode: "plan" | "apply"; confirmRealm?: string | null; approveChecked?: boolean },
  now = new Date(),
): Promise<TenantActionOutcome> {
  const action = input.mode === "plan" ? "realm.sync_plan" : "realm.sync_apply";
  const realmEnv = realmEnvForInstance(input.instance);
  const realm = realmNameForEnv(realmEnv);
  const p = await platformTenant(db);
  const md = { realm, env: realmEnv, approve: input.mode === "apply" && input.approveChecked === true };
  if (!(await gate(db, input, "realm:sync", action, p?.id ?? null, md))) return { ok: false, reason: "forbidden" };
  if (!typesEnabled(input.allowedTypes, REALM_SYNC_TYPES)) return { ok: false, reason: "disabled" };
  if (!p) return { ok: false, reason: "not_found" };
  const d = decideRealmSync({
    realmEnv,
    mode: input.mode,
    confirmRealm: input.confirmRealm,
    approveChecked: input.approveChecked,
    lastPlan: input.mode === "apply" ? await lastRealmPlan(db, p.id, realmEnv) : null,
    now,
  });
  if (!d.ok) {
    await auditRejected(db, input, action, p.id, { ...md, reason: d.code });
    if (d.code === "confirm") return { ok: false, reason: "confirm" };
    return { ok: false, reason: "realm", code: d.code };
  }
  const out = await enqueueChain(
    db,
    send,
    {
      instance: input.instance,
      allowedTypes: input.allowedTypes,
      client: { id: p.id, slug: p.slug },
      steps: [d.step],
      actor: input.actor,
      meta: input.meta,
      audit: { action, targetType: "realm", targetId: realm, metadata: md },
    },
    now,
  );
  if (!out.ok) return out;
  return { ok: true, chainId: out.chainId, jobIds: out.jobIds, clientId: p.id };
}

// ---------------------------------------------------------------------------
// Umpan balik
// ---------------------------------------------------------------------------
/** Kode `?r=` (whitelist ACTION_RESULT_CODES) — murni, diuji unit. */
export function tenantOutcomeCode(o: TenantActionOutcome): ActionResultCode {
  if (o.ok) return "queued";
  switch (o.reason) {
    case "adopt_forbidden":
      return "forbidden";
    case "retry":
      return "precondition";
    case "binding":
      return o.conflict;
    case "realm":
      return o.code;
    case "register":
      return o.issue;
    case "one_admin":
      return "one_admin";
    case "precondition":
      switch (o.detail) {
        case "host_taken":
        case "state_busy":
        case "plan_required":
        case "no_env":
        case "plan_inactive":
        case "route_manual":
          return o.detail;
        default:
          return "precondition";
      }
    case "invalid":
      return "invalid";
    default:
      return o.reason;
  }
}

export function tenantOutcomeLog(o: TenantActionOutcome): string | null {
  return !o.ok && o.reason === "error" ? o.message : null;
}
