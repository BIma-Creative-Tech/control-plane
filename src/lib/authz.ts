import "server-only";
import type { Session } from "next-auth";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { decideAccess } from "./access";
import { canAny, type Permission } from "./roles";

/**
 * Otorisasi server-side. WAJIB dipanggil di setiap page/route handler/server action yang dilindungi
 * (proxy.ts tidak dipakai untuk auth — lihat docs proxy.md §Server Functions).
 */
export async function requirePermission(permission: Permission): Promise<Session> {
  const session = await auth();
  const decision = decideAccess(session, permission);
  if (decision === "login" || !session) redirect("/login");
  if (decision === "forbidden") redirect("/forbidden");
  return session;
}

/** Salah satu izin cukup (mis. users:manage ATAU users:manage_own); batas cakupan dicek lapisan layanan. */
export async function requireAnyPermission(permissions: readonly Permission[]): Promise<Session> {
  const session = await auth();
  if (!session) redirect("/login");
  if (!canAny(session.roles, permissions)) redirect("/forbidden");
  return session;
}
