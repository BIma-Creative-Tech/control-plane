/**
 * Portal tenant (W6, ADR 0018 D9) — modul MURNI (diuji unit). Cakupan tenant portal SELALU dari baris `users` sesi
 * (`users.client_id`, dicari lewat `sub` Keycloak) — tidak pernah dari URL/form/klaim token.
 */
import type { Role } from "./roles";

export interface PortalUserRow {
  id: string;
  clientId: string | null;
  status: string;
  role: Role;
}

export interface PortalTenantRow {
  id: string;
  slug: string;
  name: string;
  status: string;
  isPlatform: boolean;
  terminatedAt: Date | null;
}

export type PortalScope =
  | { kind: "ok"; userId: string; tenant: PortalTenantRow }
  /** Belum ada baris users / belum terikat tenant klien (mis. user lama sebelum Fase 1, atau staf platform). */
  | { kind: "unbound" }
  /** Baris users berstatus disabled (sesi JWT masih hidup) → ditolak. */
  | { kind: "disabled" }
  | { kind: "terminated"; tenant: PortalTenantRow };

export function decidePortalScope(row: PortalUserRow | null, tenant: PortalTenantRow | null): PortalScope {
  if (!row) return { kind: "unbound" };
  if (row.status === "disabled") return { kind: "disabled" };
  if (!row.clientId || !tenant || tenant.id !== row.clientId || tenant.isPlatform) return { kind: "unbound" };
  if (tenant.status === "terminated" || tenant.terminatedAt !== null) return { kind: "terminated", tenant };
  return { kind: "ok", userId: row.id, tenant };
}

/** Status langganan yang ditampilkan ke tenant (label Indonesia; nilai usang tidak pernah ditulis kode baru). */
export const PORTAL_SUBSCRIPTION_LABELS: Record<string, string> = {
  implementation: "implementasi",
  warranty: "garansi",
  active: "aktif",
  past_due: "lewat jatuh tempo",
  suspended: "ditangguhkan",
};
