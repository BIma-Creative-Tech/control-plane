/**
 * Role platform (CLAUDE.md §3.4). Sumber: client role Keycloak pada client `control-plane`,
 * dipetakan ke ID token sebagai claim `resource_access.<client_id>.roles`.
 * Modul ini murni (tanpa import Next/Auth.js) agar bisa diuji unit.
 */
export const ROLES = ["superadmin", "ops", "client_admin", "client_user"] as const;
export type Role = (typeof ROLES)[number];

const ROLE_SET: ReadonlySet<string> = new Set(ROLES);

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && ROLE_SET.has(value);
}

/** Ambil role yang dikenal dari claim ID token; nilai tak dikenal dibuang. */
export function extractRoles(claims: unknown, clientId: string): Role[] {
  if (typeof claims !== "object" || claims === null) return [];
  const resourceAccess = (claims as Record<string, unknown>)["resource_access"];
  if (typeof resourceAccess !== "object" || resourceAccess === null) return [];
  const client = (resourceAccess as Record<string, unknown>)[clientId];
  if (typeof client !== "object" || client === null) return [];
  const roles = (client as Record<string, unknown>)["roles"];
  if (!Array.isArray(roles)) return [];
  return [...new Set(roles.filter(isRole))];
}

/** Kemampuan per aksi. Default deny: aksi tanpa entri = ditolak. */
export const PERMISSIONS = {
  "dashboard:view": ["superadmin", "ops", "client_admin", "client_user"],
  "clients:list": ["superadmin", "ops"],
  "clients:manage": ["superadmin"],
  "jobs:enqueue": ["superadmin", "ops"],
  /** Plan 05 §5.1: lihat daftar/detail job + environment (iterasi 1: ops/superadmin saja). */
  "jobs:view": ["superadmin", "ops"],
  /** Enqueue job Odoo/SSO (odoo_db_provision, odoo_route render, odoo_sso_provision, odoo_sso_user). */
  "jobs:odoo": ["superadmin", "ops"],
  /** Aksi berisiko: odoo_route remove, odoo_sso_disable, rotate_secret, ulang timeout_state_unknown. */
  "jobs:odoo_admin": ["superadmin"],
  "invoices:confirm": ["superadmin", "ops"],
  /** ADR 0018 (W5): lihat Subscriptions & Invoices. Client role: belum (portal W6). */
  "billing:view": ["superadmin", "ops"],
  /** Buat subscription, Go-live, akhiri, terbitkan/void invoice. Tandai lunas = `invoices:confirm`. */
  "billing:manage": ["superadmin"],
  /**
   * Kontrak Fase 1 §2.2 — `users:manage` "superadmin: semua tenant; ops: baca" dipecah menjadi `users:view`
   * (baca, superadmin+ops) dan `users:manage` (mutasi semua tenant, superadmin). Batas per tenant/role/aktor
   * ditegakkan lib/user-admin.ts (authorizeUserMutation) di server, bukan oleh peta ini saja.
   */
  "users:view": ["superadmin", "ops"],
  "users:manage": ["superadmin"],
  /**
   * Cakupan tenant sendiri (users.client_id aktor). Portal tenant W6 (keputusan Lead integrasi Fase 1): AKTIF untuk
   * client_admin HANYA lewat Server Action portal (`/portal/users`) — authorizeUserMutation menolak cakupan `own` dari
   * kanal platform (`/users` = `users:manage`) dan cakupan `all` dari kanal portal. Role yang boleh diberikan: client_user
   * saja (memberi client_admin = superadmin, Fase 1); semua aturan F1 tetap.
   */
  "users:manage_own": ["client_admin"],
  /** Job kc_realm_sync (prod/demo wajib approve). */
  "realm:sync": ["superadmin"],
  /** Halaman /audit (baca audit_logs; email tidak pernah ditampilkan). */
  "audit:view": ["superadmin", "ops"],
  /** Portal tenant W6 — `/portal` Ringkasan (read-only), dibatasi tenant users.client_id sesi (server-side). */
  "portal:view": ["client_admin", "client_user"],
  /** Portal tenant W6 — `/portal/users` dan `/portal/domains` (tenant-admin). Mutasi user = `users:manage_own`. */
  "portal:admin": ["client_admin"],
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;

/** Role platform (staf). Sesi dengan salah satu role ini memakai halaman platform, bukan portal. */
export function isPlatformStaff(roles: readonly Role[] | undefined): boolean {
  return !!roles && (roles.includes("superadmin") || roles.includes("ops"));
}

/**
 * Halaman awal per role (W6): staf platform → /dashboard; tenant-admin/tenant-user → /portal; tanpa role → /dashboard
 * (halaman itu sendiri menolak/menjelaskan). Murni (diuji unit).
 */
export function landingPath(roles: readonly Role[] | undefined): "/dashboard" | "/portal" {
  if (isPlatformStaff(roles)) return "/dashboard";
  return roles && (roles.includes("client_admin") || roles.includes("client_user")) ? "/portal" : "/dashboard";
}

/** Role paling berkuasa (untuk cache `users.role`); tanpa role → client_user (paling rendah). */
export function primaryRole(roles: readonly Role[] | undefined): Role {
  for (const r of ROLES) if (roles?.includes(r)) return r;
  return "client_user";
}

/** Label UI (ADR 0017 D5 / keputusan owner K9) — nama role di klaim & DB tidak di-rename. */
export const ROLE_LABELS: Record<Role, string> = {
  superadmin: "platform-admin",
  ops: "platform-viewer",
  client_admin: "tenant-admin",
  client_user: "tenant-user",
};

export function canAny(roles: readonly Role[] | undefined, permissions: readonly Permission[]): boolean {
  return permissions.some((p) => can(roles, p));
}

/** Peta izin (tipe umum) — `can` memakai PERMISSIONS; peta lain hanya untuk uji jalur W6 (portal tenant). */
export type PermissionMap = Readonly<Record<Permission, readonly Role[]>>;

export function canWith(map: PermissionMap, roles: readonly Role[] | undefined, permission: Permission): boolean {
  if (!roles || roles.length === 0) return false;
  const allowed: readonly Role[] = map[permission];
  return roles.some((r) => allowed.includes(r));
}

export function can(roles: readonly Role[] | undefined, permission: Permission): boolean {
  return canWith(PERMISSIONS, roles, permission);
}
