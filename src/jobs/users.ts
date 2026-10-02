/**
 * Layanan halaman Users (kontrak SaaS Fase 1 §2.3). Setiap aksi: muat aktor (users.client_id/status dari DB) +
 * tenant + target → authorizeUserMutation (murni, diuji unit) → rencana rantai → enqueueChain (satu transaksi +
 * audit). Penolakan otorisasi/prasyarat diaudit `result=rejected`. Tidak ada eksekusi di request HTTP (ADR 0009).
 * Email tidak masuk audit (hanya email_hash).
 *
 * Temuan QA F1 (Lead 2026-10-03): setiap mutasi juga melewati aturan pengikatan email (emailBindingConflict) — email
 * user lama tanpa tenant / ber-role platform / milik tenant lain tidak bisa diambil alih lewat tenant klien; user lama
 * hanya bisa diikat lewat adoptUser (superadmin, `kc_user_ensure adopt=true`).
 */
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { auditLogs, clients, environments, plans, subscriptions, tenantUserAccess, users } from "../db/schema";
import {
  EMAIL_MAX,
  EMAIL_REGEX,
  asciiName,
  emailHash,
  realmEnvForInstance,
  type BridgeJobType,
  type CpRoleArg,
  type Instance,
  type OdooAccess,
  type TenantEnv,
} from "../lib/job-contract";
import {
  authorizeAdopt,
  authorizeUserMutation,
  buildAddUserSteps,
  buildAdoptSteps,
  buildDisableSteps,
  buildEnableSteps,
  buildAccessSteps,
  buildPasswordResetSteps,
  emailBindingConflict,
  envsForInstance,
  planLimitAllows,
  type ChainStep,
  type PlanLimitInfo,
  type UserChannel,
  type UserAuthzResult,
  type TargetUser,
  type TenantRef,
  type UserActorContext,
  type UserAuthzDenial,
  type UserMutation,
  type UserStatus,
} from "../lib/user-admin";
import type { ActionResultCode } from "../lib/job-list-params";
import { ChainAbort, enqueueChain, type ChainFailure } from "./chain";
import type { Actor, RequestMeta, SendFn, Tx } from "./service";

export interface UsersServiceInput {
  instance: Instance;
  allowedTypes: readonly BridgeJobType[];
  actor: Actor;
  meta: RequestMeta;
  /**
   * W6: kanal pemanggil (default `platform` = /users). `portal` = /portal/users: cakupan tenant sendiri saja, batas
   * user plan untuk tambah/aktifkan (lib/user-admin.ts authorizeUserMutation + planLimitAllows).
   */
  channel?: UserChannel;
}

export type UserActionFailure =
  | { reason: "authz"; denial: UserAuthzDenial }
  | { reason: "not_found" }
  | { reason: "disabled" }
  | {
      reason: "precondition";
      detail: "email_other_tenant" | "email_unbound" | "email_platform_role" | "email_invalid" | "name_invalid" | "env_unknown" | "no_email";
    }
  | ChainFailure;

export type UserActionOutcome = { ok: true; chainId: string; jobIds: string[] } | ({ ok: false } & UserActionFailure);

/** Tipe yang dibutuhkan halaman Users — fitur nonaktif bila instance belum mengizinkan semuanya. */
export const USER_FEATURE_TYPES: readonly BridgeJobType[] = [
  "kc_org_ensure",
  "kc_user_ensure",
  "kc_user_set_roles",
  "kc_user_set_enabled",
  "kc_user_action_email",
  "odoo_user_ensure",
];

export function userFeatureEnabled(allowed: readonly BridgeJobType[]): boolean {
  return USER_FEATURE_TYPES.every((t) => allowed.includes(t));
}

async function loadActor(db: Db, actor: Actor): Promise<UserActorContext> {
  const row = actor.userId
    ? (await db.select({ clientId: users.clientId, status: users.status, role: users.role }).from(users).where(eq(users.id, actor.userId)).limit(1))[0]
    : undefined;
  return {
    sub: actor.sub,
    roles: actor.roles,
    userId: actor.userId,
    clientId: row?.clientId ?? null,
    status: (row?.status as UserStatus) ?? null,
    role: row?.role ?? null,
  };
}

async function loadTenant(db: Db, clientId: string) {
  const row = (
    await db
      .select({ id: clients.id, slug: clients.slug, isPlatform: clients.isPlatform, terminatedAt: clients.terminatedAt, kcOrgId: clients.kcOrgId })
      .from(clients)
      .where(eq(clients.id, clientId))
      .limit(1)
  )[0];
  if (!row) return null;
  const tenant: TenantRef = { id: row.id, slug: row.slug, isPlatform: row.isPlatform, terminated: row.terminatedAt !== null };
  return { tenant, kcOrgId: row.kcOrgId };
}

async function loadEnvs(db: Db, instance: Instance, clientId: string) {
  const rows = await db
    .select({ environmentId: environments.id, kind: environments.kind })
    .from(environments)
    .where(eq(environments.clientId, clientId));
  return envsForInstance(instance, rows as { environmentId: string; kind: TenantEnv }[]);
}

async function loadExistingAccess(db: Db, envIds: string[], email: string) {
  if (envIds.length === 0) return [];
  const rows = await db
    .select({ environmentId: tenantUserAccess.environmentId, status: tenantUserAccess.status, isAdmin: tenantUserAccess.isTenantAdmin })
    .from(tenantUserAccess)
    .where(and(inArray(tenantUserAccess.environmentId, envIds), eq(tenantUserAccess.email, email)));
  return rows;
}

async function loadTarget(db: Db, userId: string): Promise<(TargetUser & { displayName: string | null }) | null> {
  const row = (await db.select().from(users).where(eq(users.id, userId)).limit(1))[0];
  if (!row) return null;
  return {
    id: row.id,
    keycloakSub: row.keycloakSub,
    email: row.email,
    role: row.role,
    status: row.status as UserStatus,
    clientId: row.clientId,
    displayName: row.displayName,
  };
}

/**
 * Batas user plan (portal W6): langganan layanan odoo non-terminated terbaru tenant → plans.max_users. Tanpa langganan
 * → tidak dicek (dicatat di audit `plan_limit`).
 */
export async function loadPlanLimit(db: Db | Tx, clientId: string): Promise<PlanLimitInfo> {
  const row = (
    await db
      .select({ code: plans.code, maxUsers: plans.maxUsers })
      .from(subscriptions)
      .innerJoin(plans, eq(plans.id, subscriptions.planId))
      .where(and(eq(subscriptions.clientId, clientId), eq(plans.service, "odoo"), ne(subscriptions.status, "terminated")))
      .orderBy(desc(subscriptions.createdAt))
      .limit(1)
  )[0];
  if (!row) return { kind: "no_subscription" };
  return row.maxUsers === null ? { kind: "unlimited", planCode: row.code } : { kind: "limited", planCode: row.code, maxUsers: row.maxUsers };
}

/**
 * Kursi terpakai tenant: users invited/active + email yang sedang diproses job aktif (kc_user_ensure, atau
 * kc_user_set_enabled enabled=true) dan belum tercatat invited/active — agar dua tambah paralel tidak melewati batas.
 */
export async function countTenantSeats(db: Db | Tx, clientId: string): Promise<number> {
  const r = await db.execute<{ n: number }>(sql`
    SELECT (SELECT count(*) FROM users WHERE client_id = ${clientId} AND status IN ('invited', 'active'))::int
         + (SELECT count(DISTINCT lower(j.payload -> 'args' ->> 'email'))
              FROM provision_jobs j
             WHERE j.client_id = ${clientId}
               AND j.dry_run = false
               AND j.status IN ('queued', 'dispatched', 'running')
               AND (j.type = 'kc_user_ensure' OR (j.type = 'kc_user_set_enabled' AND j.payload -> 'args' ->> 'enabled' = 'true'))
               AND NOT EXISTS (
                 SELECT 1 FROM users u
                  WHERE u.client_id = ${clientId} AND u.status IN ('invited', 'active')
                    AND lower(u.email) = lower(j.payload -> 'args' ->> 'email')))::int AS n`);
  return Number(r.rows[0]?.n ?? 0);
}

function planLimitMd(l: PlanLimitInfo): Record<string, unknown> {
  return l.kind === "limited" ? { kind: l.kind, plan: l.planCode, max_users: l.maxUsers } : l.kind === "unlimited" ? { kind: l.kind, plan: l.planCode } : { kind: l.kind };
}

async function otherAdmins(db: Db, clientId: string, excludeUserId: string | null): Promise<number> {
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.clientId, clientId), eq(users.role, "client_admin"), inArray(users.status, ["invited", "active"])));
  return rows.filter((r) => r.id !== excludeUserId).length;
}

/** Baris users lain dengan email sama (lower) — untuk emailBindingConflict. */
async function usersByEmail(db: Db, email: string) {
  return db
    .select({ id: users.id, clientId: users.clientId, role: users.role })
    .from(users)
    .where(sql`lower(${users.email}) = ${email.toLowerCase()}`)
    .limit(20);
}

async function auditRejected(
  db: Db,
  input: UsersServiceInput,
  action: string,
  clientId: string | null,
  targetId: string | null,
  md: Record<string, unknown>,
) {
  try {
    await db.insert(auditLogs).values({
      actorUserId: input.actor.userId,
      actor: `user:${input.actor.sub}`,
      action,
      targetType: "user",
      targetId,
      clientId,
      result: "rejected",
      ip: input.meta.ip,
      requestId: input.meta.requestId,
      metadata: md,
    });
  } catch {
    // diabaikan
  }
}

/** QA N5: kanal portal tidak pernah memberi akses Odoo `admin` (hanya none|user) — ditolak role_not_allowed. */
function portalOdooAdmin(input: UsersServiceInput, m: ReadonlyMap<string, OdooAccess>): UserActionFailure | null {
  return input.channel === "portal" && [...m.values()].includes("admin") ? { reason: "authz", denial: "role_not_allowed" } : null;
}

/** Akses Odoo dari form: hanya environment tenant yang dilayani instance ini; id lain → env_unknown. */
function accessMap(envs: readonly { environmentId: string }[], raw: Readonly<Record<string, OdooAccess>>): Map<string, OdooAccess> | null {
  const known = new Set(envs.map((e) => e.environmentId));
  const m = new Map<string, OdooAccess>();
  for (const [id, a] of Object.entries(raw)) {
    if (!known.has(id)) return null;
    m.set(id, a);
  }
  return m;
}

async function run(
  db: Db,
  send: SendFn,
  input: UsersServiceInput,
  p: {
    action: string;
    tenant: TenantRef;
    targetId: string | null;
    mutation: UserMutation;
    excludeAdmin: string | null;
    email: string;
    /** Otorisasi khusus (adopt); default authorizeUserMutation(mutation). */
    authorize?: (actor: UserActorContext, otherActiveAdmins: number, channel: UserChannel) => UserAuthzResult;
    /** Baris yang dikecualikan dari aturan pengikatan email (target adopt, client_id NULL). */
    bindingExcludeId?: string | null;
    /** Prasyarat SETELAH otorisasi (tidak membocorkan data tenant lain ke aktor yang tidak berwenang). */
    pre?: () => Promise<UserActionFailure | null>;
    steps: () => ChainStep[];
    md: () => Record<string, unknown>;
  },
): Promise<UserActionOutcome> {
  const actor = await loadActor(db, input.actor);
  const baseMd = { tenant: p.tenant.slug, email_hash: emailHash(p.email) };
  const nAdmins = await otherAdmins(db, p.tenant.id, p.excludeAdmin);
  const channel = input.channel ?? "platform";
  const authz = p.authorize
    ? p.authorize(actor, nAdmins, channel)
    : authorizeUserMutation(actor, p.tenant, p.mutation, { otherActiveAdmins: nAdmins, channel });
  if (!authz.ok) {
    await auditRejected(db, input, p.action, p.tenant.id, p.targetId, { ...baseMd, reason: "authz", denial: authz.reason });
    return { ok: false, reason: "authz", denial: authz.reason };
  }
  let failure = p.pre ? await p.pre() : null;
  if (!failure) {
    // F1.2: berlaku untuk SETIAP mutasi (tambah, ubah akses, nonaktif/aktif, reset, adopt).
    const conflict = emailBindingConflict(p.tenant, await usersByEmail(db, p.email), p.bindingExcludeId ?? null);
    if (conflict) failure = { reason: "precondition", detail: conflict };
  }
  if (failure) {
    await auditRejected(db, input, p.action, p.tenant.id, p.targetId, {
      ...baseMd,
      reason: failure.reason,
      ...("detail" in failure ? { detail: failure.detail } : {}),
      ...("denial" in failure ? { denial: failure.denial } : {}),
    });
    return { ok: false, ...failure };
  }
  // W6: tambah/aktifkan dari portal tunduk batas user plan — dicek ulang di transaksi enqueue di bawah kunci per
  // tenant (paralel aman); tanpa langganan Odoo → tidak dicek, dicatat di audit.
  const seat = channel === "portal" && (p.mutation.kind === "add" || p.mutation.kind === "enable");
  const limit = seat ? await loadPlanLimit(db, p.tenant.id) : null;
  const md = { ...p.md(), ...baseMd, ...(limit ? { plan_limit: planLimitMd(limit) } : {}) };
  const out = await enqueueChain(db, send, {
    instance: input.instance,
    allowedTypes: input.allowedTypes,
    client: { id: p.tenant.id, slug: p.tenant.slug },
    steps: p.steps(),
    actor: input.actor,
    meta: input.meta,
    audit: { action: p.action, targetType: "user", targetId: p.targetId, metadata: { ...md, scope: authz.scope, channel } },
    ...(limit && limit.kind === "limited"
      ? {
          prelude: async (tx: Tx) => {
            await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`tenant-seats:${p.tenant.id}`}))`);
            if (!planLimitAllows(limit, await countTenantSeats(tx, p.tenant.id))) {
              throw new ChainAbort({ reason: "precondition", detail: "plan_limit" });
            }
          },
        }
      : {}),
  });
  if (!out.ok) return out;
  return { ok: true, chainId: out.chainId, jobIds: out.jobIds };
}

export async function addUser(
  db: Db,
  send: SendFn,
  input: UsersServiceInput & {
    clientId: string;
    email: string;
    name: string | null;
    cpRole: CpRoleArg;
    odoo: Readonly<Record<string, OdooAccess>>;
  },
): Promise<UserActionOutcome> {
  if (!userFeatureEnabled(input.allowedTypes)) return { ok: false, reason: "disabled" };
  const t = await loadTenant(db, input.clientId);
  if (!t) return { ok: false, reason: "not_found" };
  const email = input.email.trim().toLowerCase();
  const realmEnv = realmEnvForInstance(input.instance);
  let envs: Awaited<ReturnType<typeof loadEnvs>> = [];
  let access = new Map<string, OdooAccess>();
  let name: string | null = null;
  return run(db, send, input, {
    action: "user.add",
    tenant: t.tenant,
    targetId: null,
    mutation: { kind: "add", cpRole: input.cpRole },
    excludeAdmin: null,
    email,
    pre: async () => {
      if (email.length > EMAIL_MAX || !EMAIL_REGEX.test(email)) return { reason: "precondition", detail: "email_invalid" };
      envs = await loadEnvs(db, input.instance, t.tenant.id);
      const m = accessMap(envs, input.odoo);
      if (!m) return { reason: "precondition", detail: "env_unknown" };
      const denied = portalOdooAdmin(input, m);
      if (denied) return denied;
      access = m;
      // Nama non-ASCII DITOLAK (keputusan Lead Fase 1) — tidak ditransliterasi/dibuang diam-diam.
      if (input.name && input.name.trim() !== "") {
        name = asciiName(input.name);
        if (name === null) return { reason: "precondition", detail: "name_invalid" };
      }
      // Email tenant lain / user lama tanpa tenant / role platform → ditolak di run() (emailBindingConflict, F1.2).
      return null;
    },
    md: () => ({ cp_role: input.cpRole, odoo: Object.fromEntries(access) }),
    steps: () =>
      buildAddUserSteps({ tenant: t.tenant, realmEnv, email, name, cpRole: input.cpRole, envs, access, needOrg: t.kcOrgId === null }),
  });
}

async function targetContext(db: Db, input: UsersServiceInput, userId: string) {
  const target = await loadTarget(db, userId);
  if (!target || !target.clientId) return null;
  const t = await loadTenant(db, target.clientId);
  if (!t) return null;
  return { target, ...t };
}

function validEmail(e: string | null): e is string {
  return e !== null && e.length <= EMAIL_MAX && EMAIL_REGEX.test(e);
}

export async function changeUserAccess(
  db: Db,
  send: SendFn,
  input: UsersServiceInput & { userId: string; cpRole: CpRoleArg; odoo: Readonly<Record<string, OdooAccess>> },
): Promise<UserActionOutcome> {
  if (!userFeatureEnabled(input.allowedTypes)) return { ok: false, reason: "disabled" };
  const c = await targetContext(db, input, input.userId);
  if (!c) return { ok: false, reason: "not_found" };
  const email = c.target.email ?? "";
  const realmEnv = realmEnvForInstance(input.instance);
  const name = c.target.displayName ? asciiName(c.target.displayName) : null;
  let envs: Awaited<ReturnType<typeof loadEnvs>> = [];
  let access = new Map<string, OdooAccess>();
  let existing: Awaited<ReturnType<typeof loadExistingAccess>> = [];
  return run(db, send, input, {
    action: "user.change_access",
    tenant: c.tenant,
    targetId: c.target.id,
    mutation: { kind: "change_access", target: c.target, cpRole: input.cpRole },
    excludeAdmin: c.target.id,
    email,
    pre: async () => {
      if (!validEmail(c.target.email)) return { reason: "precondition", detail: "no_email" };
      envs = await loadEnvs(db, input.instance, c.tenant.id);
      const m = accessMap(envs, input.odoo);
      if (!m) return { reason: "precondition", detail: "env_unknown" };
      const denied = portalOdooAdmin(input, m);
      if (denied) return denied;
      access = m;
      existing = await loadExistingAccess(db, envs.map((e) => e.environmentId), email);
      return null;
    },
    md: () => ({ cp_role: input.cpRole, previous_role: c.target.role, odoo: Object.fromEntries(access) }),
    steps: () => buildAccessSteps({ tenant: c.tenant, realmEnv, email, cpRole: input.cpRole, envs, access, existing, name }),
  });
}

export async function setUserEnabled(
  db: Db,
  send: SendFn,
  input: UsersServiceInput & { userId: string; enabled: boolean; odoo?: Readonly<Record<string, OdooAccess>> },
): Promise<UserActionOutcome> {
  if (!userFeatureEnabled(input.allowedTypes)) return { ok: false, reason: "disabled" };
  const c = await targetContext(db, input, input.userId);
  if (!c) return { ok: false, reason: "not_found" };
  const email = c.target.email ?? "";
  const realmEnv = realmEnvForInstance(input.instance);
  const name = c.target.displayName ? asciiName(c.target.displayName) : null;
  let envs: Awaited<ReturnType<typeof loadEnvs>> = [];
  let access = new Map<string, OdooAccess>();
  let existing: Awaited<ReturnType<typeof loadExistingAccess>> = [];
  const pre = async (): Promise<UserActionFailure | null> => {
    if (!validEmail(c.target.email)) return { reason: "precondition", detail: "no_email" };
    envs = await loadEnvs(db, input.instance, c.tenant.id);
    existing = await loadExistingAccess(db, envs.map((e) => e.environmentId), email);
    if (input.enabled) {
      const m = accessMap(envs, input.odoo ?? {});
      if (!m) return { reason: "precondition", detail: "env_unknown" };
      const denied = portalOdooAdmin(input, m);
      if (denied) return denied;
      access = m;
    }
    return null;
  };
  if (!input.enabled) {
    return run(db, send, input, {
      action: "user.disable",
      tenant: c.tenant,
      targetId: c.target.id,
      mutation: { kind: "disable", target: c.target },
      excludeAdmin: c.target.id,
      email,
      pre,
      md: () => ({ role: c.target.role }),
      steps: () => buildDisableSteps({ realmEnv, email, tenant: c.tenant, envs, existing }),
    });
  }
  return run(db, send, input, {
    action: "user.enable",
    tenant: c.tenant,
    targetId: c.target.id,
    mutation: { kind: "enable", target: c.target, cpRole: c.target.role },
    excludeAdmin: c.target.id,
    email,
    pre,
    md: () => ({ role: c.target.role, odoo: Object.fromEntries(access) }),
    steps: () => buildEnableSteps({ tenant: c.tenant, realmEnv, email, cpRole: c.target.role, envs, access, existing, name }),
  });
}

export async function sendPasswordReset(
  db: Db,
  send: SendFn,
  input: UsersServiceInput & { userId: string },
): Promise<UserActionOutcome> {
  if (!userFeatureEnabled(input.allowedTypes)) return { ok: false, reason: "disabled" };
  const c = await targetContext(db, input, input.userId);
  if (!c) return { ok: false, reason: "not_found" };
  const email = c.target.email ?? "";
  return run(db, send, input, {
    action: "user.password_reset",
    tenant: c.tenant,
    targetId: c.target.id,
    mutation: { kind: "password_reset", target: c.target },
    excludeAdmin: c.target.id,
    email,
    pre: async () => (validEmail(c.target.email) ? null : { reason: "precondition", detail: "no_email" }),
    md: () => ({}),
    steps: () => buildPasswordResetSteps({ realmEnv: realmEnvForInstance(input.instance), email }),
  });
}

/**
 * "Ikat ke tenant…" (temuan QA F1.4/F8): baris users lama `client_id IS NULL` → rantai kc_user_ensure adopt=true →
 * kc_user_set_roles. Superadmin saja (authorizeAdopt); rekonsiliasi mengisi users.client_id setelah sukses.
 */
export async function adoptUser(
  db: Db,
  send: SendFn,
  input: UsersServiceInput & { userId: string; clientId: string; cpRole: CpRoleArg },
): Promise<UserActionOutcome> {
  if (!userFeatureEnabled(input.allowedTypes)) return { ok: false, reason: "disabled" };
  const target = await loadTarget(db, input.userId);
  const t = await loadTenant(db, input.clientId);
  if (!target || !t) return { ok: false, reason: "not_found" };
  const email = (target.email ?? "").trim().toLowerCase();
  return run(db, send, input, {
    action: "user.adopt",
    tenant: t.tenant,
    targetId: target.id,
    // Tidak dipakai (authorize khusus); dipertahankan untuk tipe run().
    mutation: { kind: "change_access", target, cpRole: input.cpRole },
    excludeAdmin: target.id,
    email,
    authorize: (actor, n, channel) => authorizeAdopt(actor, t.tenant, target, input.cpRole, { otherActiveAdmins: n, channel }),
    bindingExcludeId: target.id,
    pre: async () => (validEmail(email) ? null : { reason: "precondition", detail: "no_email" }),
    md: () => ({ cp_role: input.cpRole, previous_role: target.role, adopt: true }),
    steps: () => buildAdoptSteps({ tenant: t.tenant, realmEnv: realmEnvForInstance(input.instance), email, cpRole: input.cpRole, needOrg: t.kcOrgId === null }),
  });
}

/** Pesan aman untuk log pemanggil (sudah SQLSTATE/constraint saja, tanpa query/params). */
export function outcomeLogMessage(o: UserActionOutcome): string | null {
  return !o.ok && o.reason === "error" ? o.message : null;
}

/** Kode umpan balik `?r=` (whitelist ACTION_RESULT_CODES) dari hasil aksi user — murni, diuji unit. */
export function userOutcomeCode(o: UserActionOutcome): ActionResultCode {
  if (o.ok) return "queued";
  switch (o.reason) {
    case "authz":
      switch (o.denial) {
        case "forbidden":
        case "actor_disabled":
          return "forbidden";
        case "target_disabled":
          return "user_disabled";
        default:
          return o.denial;
      }
    case "adopt_forbidden":
      return "forbidden";
    case "precondition":
      if (o.detail === "email_other_tenant" || o.detail === "email_unbound" || o.detail === "email_platform_role" || o.detail === "name_invalid") {
        return o.detail;
      }
      if (o.detail === "no_email") return "precondition";
      if (o.detail === "plan_limit") return "plan_limit";
      return "invalid";
    default:
      return o.reason;
  }
}
