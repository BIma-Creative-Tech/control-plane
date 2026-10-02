/**
 * Administrasi user lintas tenant (kontrak SaaS Fase 1 §2.2–§2.3, ADR 0017/0018). Modul MURNI (tanpa Next/DB) —
 * diuji unit: otorisasi tingkat aksi (siapa boleh mengubah user mana dengan role apa) dan perencanaan rantai job
 * (`kc_user_ensure → kc_user_set_roles → odoo_user_ensure`). Pemanggil (jobs/users.ts) memuat data dari DB lalu
 * memanggil fungsi di sini; tidak ada keputusan otorisasi yang hanya bergantung pada tombol UI.
 */
import {
  ODOO_ACCESS,
  PLATFORM_SLUG,
  cpRolesForSlug,
  envAllowedForInstance,
  type BridgeJobType,
  type CpRoleArg,
  type Instance,
  type OdooAccess,
  type TenantEnv,
} from "./job-contract";
import { can, type Role } from "./roles";

export const USER_STATUSES = ["invited", "active", "disabled"] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export interface UserActorContext {
  sub: string;
  roles: readonly Role[];
  /** users.id aktor (null = baris belum ada). */
  userId: string | null;
  /** users.client_id aktor — satu-satunya sumber tenant untuk client_admin (klaim `tenant_id` belum dipercaya). */
  clientId: string | null;
  status: UserStatus | null;
}

export interface TenantRef {
  id: string;
  slug: string;
  isPlatform: boolean;
  terminated: boolean;
}

export interface TargetUser {
  id: string;
  keycloakSub: string;
  email: string | null;
  role: Role;
  status: UserStatus;
  clientId: string | null;
}

export type UserMutation =
  | { kind: "add"; cpRole: CpRoleArg }
  | { kind: "change_access"; target: TargetUser; cpRole: CpRoleArg }
  | { kind: "disable"; target: TargetUser }
  | { kind: "enable"; target: TargetUser; cpRole: CpRoleArg }
  | { kind: "password_reset"; target: TargetUser };

export type UserAuthzDenial =
  /** Tanpa users:manage / users:manage_own. */
  | "forbidden"
  /** client_admin di luar tenant sendiri, atau target bukan anggota tenant ini. */
  | "cross_tenant"
  /** Role tidak boleh untuk tenant ini (§0.3) atau di luar cakupan aktor. */
  | "role_not_allowed"
  /** Menonaktifkan / mengubah role diri sendiri. */
  | "self_action"
  /** Tenant sudah punya tenant-admin invited/active (ADR 0018 D3). */
  | "one_admin"
  /** Baris users aktor berstatus disabled (sesi JWT masih hidup ≤ 8 jam setelah dinonaktifkan). */
  | "actor_disabled"
  | "tenant_inactive"
  | "target_disabled";

export type UserAuthzResult = { ok: true; scope: "all" | "own" } | { ok: false; reason: UserAuthzDenial };

/** Role yang boleh DIBERIKAN client_admin (kontrak §2.2: hanya client_user/client_admin, tanpa `none`). */
export const OWN_SCOPE_ROLES: readonly CpRoleArg[] = ["client_user", "client_admin"];

function rolesAllowedFor(tenant: TenantRef, scope: "all" | "own"): readonly CpRoleArg[] {
  const bySlug = cpRolesForSlug(tenant.isPlatform ? PLATFORM_SLUG : tenant.slug);
  return scope === "all" ? bySlug : bySlug.filter((r) => OWN_SCOPE_ROLES.includes(r));
}

export function assignableRoles(actorRoles: readonly Role[], tenant: TenantRef): readonly CpRoleArg[] {
  if (can(actorRoles, "users:manage")) return rolesAllowedFor(tenant, "all");
  if (can(actorRoles, "users:manage_own") && !tenant.isPlatform) return rolesAllowedFor(tenant, "own");
  return [];
}

/**
 * Otorisasi satu mutasi user. `otherActiveAdmins` = jumlah client_admin invited/active di tenant ini SELAIN target
 * (untuk `add`: semua admin tenant). Urutan cek: aktor → cakupan tenant → target → role → aturan diri → satu admin.
 */
export function authorizeUserMutation(
  actor: UserActorContext,
  tenant: TenantRef,
  m: UserMutation,
  ctx: { otherActiveAdmins: number },
): UserAuthzResult {
  if (actor.status === "disabled") return { ok: false, reason: "actor_disabled" };

  let scope: "all" | "own";
  if (can(actor.roles, "users:manage")) {
    scope = "all";
  } else if (can(actor.roles, "users:manage_own")) {
    scope = "own";
    // Tenant aktor dari users.client_id (DB), bukan dari input form/klaim.
    if (actor.clientId === null || actor.clientId !== tenant.id || tenant.isPlatform) return { ok: false, reason: "cross_tenant" };
  } else {
    return { ok: false, reason: "forbidden" };
  }

  const target = m.kind === "add" ? null : m.target;
  if (target) {
    if (target.clientId !== tenant.id) return { ok: false, reason: "cross_tenant" };
    // Pertahanan berlapis: client_admin tidak pernah menyentuh user ber-role platform.
    if (scope === "own" && (target.role === "superadmin" || target.role === "ops")) return { ok: false, reason: "role_not_allowed" };
  }
  if (tenant.terminated && m.kind !== "disable") return { ok: false, reason: "tenant_inactive" };

  const requested = m.kind === "add" || m.kind === "change_access" || m.kind === "enable" ? m.cpRole : null;
  if (requested !== null && !rolesAllowedFor(tenant, scope).includes(requested)) return { ok: false, reason: "role_not_allowed" };

  if (target && target.keycloakSub === actor.sub) {
    if (m.kind === "disable") return { ok: false, reason: "self_action" };
    if ((m.kind === "change_access" || m.kind === "enable") && requested !== target.role) return { ok: false, reason: "self_action" };
  }
  if (target && target.status === "disabled" && (m.kind === "change_access" || m.kind === "password_reset")) {
    return { ok: false, reason: "target_disabled" };
  }

  // ADR 0018 D3: tepat satu tenant-admin invited/active per tenant non-platform.
  const becomesAdmin = requested === "client_admin" && !(target && target.role === "client_admin" && target.status !== "disabled");
  if (requested === "client_admin" && (becomesAdmin || m.kind === "enable") && ctx.otherActiveAdmins > 0) {
    return { ok: false, reason: "one_admin" };
  }
  return { ok: true, scope };
}

// ---------------------------------------------------------------------------
// Perencanaan rantai job
// ---------------------------------------------------------------------------
export interface ChainStep {
  type: BridgeJobType;
  env: TenantEnv;
  args: Record<string, unknown>;
}

export interface TenantEnvRef {
  environmentId: string;
  kind: TenantEnv;
}

/** Akses Odoo per environment yang ADA saat ini (baris tenant_user_access untuk email ini). */
export interface ExistingOdooAccess {
  environmentId: string;
  status: string;
  isAdmin: boolean;
}

export function isOdooAccess(v: unknown): v is OdooAccess {
  return typeof v === "string" && (ODOO_ACCESS as readonly string[]).includes(v);
}

/** Environment tenant yang dilayani instance ini (job Odoo hanya untuk env ini). */
export function envsForInstance<T extends TenantEnvRef>(instance: Instance, envs: readonly T[]): T[] {
  return envs.filter((e) => envAllowedForInstance(instance, e.kind));
}

/**
 * Langkah akses (role CP + Odoo per env). Platform: satu `kc_user_set_roles` tanpa `odoo` (dilarang §1).
 * Tenant: `kc_user_set_roles` per env yang diberi akses (atau yang aksesnya dicabut), lalu `odoo_user_ensure` per env
 * (`active=true` untuk akses user/admin, `active=false` untuk env yang sebelumnya aktif lalu diubah ke none).
 */
export function buildAccessSteps(p: {
  tenant: TenantRef;
  realmEnv: TenantEnv;
  email: string;
  cpRole: CpRoleArg;
  envs: readonly TenantEnvRef[];
  access: ReadonlyMap<string, OdooAccess>;
  existing?: readonly ExistingOdooAccess[];
  name?: string | null;
}): ChainStep[] {
  if (p.tenant.isPlatform) {
    return [{ type: "kc_user_set_roles", env: p.realmEnv, args: { email: p.email, cp_role: p.cpRole } }];
  }
  const existing = new Map((p.existing ?? []).map((e) => [e.environmentId, e]));
  const roleSteps: ChainStep[] = [];
  const odooSteps: ChainStep[] = [];
  for (const env of p.envs) {
    const want = p.access.get(env.environmentId) ?? "none";
    const had = existing.get(env.environmentId);
    const hadActive = had !== undefined && had.status === "active";
    if (want === "none" && !hadActive) continue;
    roleSteps.push({ type: "kc_user_set_roles", env: env.kind, args: { email: p.email, cp_role: p.cpRole, odoo: want } });
    if (want === "none") {
      odooSteps.push({ type: "odoo_user_ensure", env: env.kind, args: { email: p.email, role: had?.isAdmin ? "admin" : "user", active: false } });
    } else {
      odooSteps.push({
        type: "odoo_user_ensure",
        env: env.kind,
        args: { email: p.email, role: want, active: true, ...(p.name ? { name: p.name } : {}) },
      });
    }
  }
  if (roleSteps.length === 0) {
    roleSteps.push({ type: "kc_user_set_roles", env: p.realmEnv, args: { email: p.email, cp_role: p.cpRole } });
  }
  return [...roleSteps, ...odooSteps];
}

/** Tambah user: [kc_org_ensure bila org belum tercatat] → kc_user_ensure (undangan) → akses. */
export function buildAddUserSteps(p: {
  tenant: TenantRef;
  realmEnv: TenantEnv;
  email: string;
  name: string | null;
  cpRole: CpRoleArg;
  envs: readonly TenantEnvRef[];
  access: ReadonlyMap<string, OdooAccess>;
  needOrg: boolean;
}): ChainStep[] {
  const steps: ChainStep[] = [];
  if (p.needOrg) steps.push({ type: "kc_org_ensure", env: p.realmEnv, args: { tenant_id: p.tenant.id } });
  steps.push({
    type: "kc_user_ensure",
    env: p.realmEnv,
    args: { email: p.email, tenant_id: p.tenant.id, invite: true, ...(p.name ? { name: p.name } : {}) },
  });
  return [...steps, ...buildAccessSteps({ ...p, existing: [] })];
}

/** Nonaktifkan: Keycloak (enabled=false + logout) dulu, lalu user Odoo di setiap env yang aksesnya aktif. */
export function buildDisableSteps(p: {
  realmEnv: TenantEnv;
  email: string;
  tenant: TenantRef;
  envs: readonly TenantEnvRef[];
  existing: readonly ExistingOdooAccess[];
}): ChainStep[] {
  const steps: ChainStep[] = [{ type: "kc_user_set_enabled", env: p.realmEnv, args: { email: p.email, enabled: false } }];
  if (p.tenant.isPlatform) return steps;
  const byId = new Map(p.existing.map((e) => [e.environmentId, e]));
  for (const env of p.envs) {
    const had = byId.get(env.environmentId);
    if (had && had.status === "active") {
      steps.push({ type: "odoo_user_ensure", env: env.kind, args: { email: p.email, role: had.isAdmin ? "admin" : "user", active: false } });
    }
  }
  return steps;
}

/** Aktifkan: Keycloak enabled=true, lalu akses sesuai form (desired state per env, terlihat operator). */
export function buildEnableSteps(p: Parameters<typeof buildAccessSteps>[0]): ChainStep[] {
  return [{ type: "kc_user_set_enabled", env: p.realmEnv, args: { email: p.email, enabled: true } }, ...buildAccessSteps(p)];
}

export function buildPasswordResetSteps(p: { realmEnv: TenantEnv; email: string }): ChainStep[] {
  return [{ type: "kc_user_action_email", env: p.realmEnv, args: { email: p.email, action: "UPDATE_PASSWORD" } }];
}

// ---------------------------------------------------------------------------
// Tampilan rantai (status per langkah)
// ---------------------------------------------------------------------------
export interface ChainStepRow {
  id: string;
  type: string;
  env: string | null;
  status: string;
  errorCode: string | null;
  afterJobId: string | null;
  createdAt: Date;
  email: string | null;
  slug: string | null;
}

/** Urutkan langkah satu rantai mengikuti after_job_id (kepala = langkah tanpa pendahulu di rantai ini). */
export function orderChain(steps: ChainStepRow[]): ChainStepRow[] {
  const ids = new Set(steps.map((s) => s.id));
  const byAfter = new Map<string, ChainStepRow>();
  for (const s of steps) if (s.afterJobId && ids.has(s.afterJobId)) byAfter.set(s.afterJobId, s);
  const head = steps.find((s) => !s.afterJobId || !ids.has(s.afterJobId));
  const out: ChainStepRow[] = [];
  for (let cur = head; cur && out.length < steps.length; cur = byAfter.get(cur.id)) out.push(cur);
  // Sisa (tidak terhubung — mestinya tidak ada) tetap ditampilkan di akhir.
  for (const s of steps) if (!out.includes(s)) out.push(s);
  return out;
}
