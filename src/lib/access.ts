import { can, type Permission, type Role } from "./roles";

export type AccessDecision = "ok" | "login" | "forbidden";

/** Keputusan otorisasi murni (diuji unit). Tidak ada sesi → login; tanpa izin → forbidden. */
export function decideAccess(session: { roles?: readonly Role[] } | null | undefined, permission: Permission): AccessDecision {
  if (!session) return "login";
  return can(session.roles, permission) ? "ok" : "forbidden";
}
