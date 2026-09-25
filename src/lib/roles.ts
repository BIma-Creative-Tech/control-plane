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
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;

/** Role paling berkuasa (untuk cache `users.role`); tanpa role → client_user (paling rendah). */
export function primaryRole(roles: readonly Role[] | undefined): Role {
  for (const r of ROLES) if (roles?.includes(r)) return r;
  return "client_user";
}

export function can(roles: readonly Role[] | undefined, permission: Permission): boolean {
  if (!roles || roles.length === 0) return false;
  const allowed: readonly Role[] = PERMISSIONS[permission];
  return roles.some((r) => allowed.includes(r));
}
