import "server-only";
import type { Session } from "next-auth";
import { redirect } from "next/navigation";
import { getDb } from "@/db";
import { loadPortalIdentity } from "@/db/portal-queries";
import { requirePermission } from "@/lib/authz";
import { isValidSub } from "@/lib/identity";
import { decidePortalScope, type PortalScope } from "@/lib/portal";
import type { Permission } from "@/lib/roles";

/**
 * Gerbang halaman portal (W6): izin (portal:view | portal:admin) → baris users sesi (by sub) → cakupan tenant dari
 * users.client_id. Baris disabled → /forbidden. Tenant TIDAK PERNAH dibaca dari URL/searchParams.
 */
export async function requirePortal(permission: Extract<Permission, "portal:view" | "portal:admin">): Promise<{ session: Session; scope: PortalScope }> {
  const session = await requirePermission(permission);
  const sub = session.user?.id;
  if (!isValidSub(sub)) return { session, scope: { kind: "unbound" } };
  const { user, tenant } = await loadPortalIdentity(getDb(), sub);
  const scope = decidePortalScope(user, tenant);
  if (scope.kind === "disabled") redirect("/forbidden");
  return { session, scope };
}
