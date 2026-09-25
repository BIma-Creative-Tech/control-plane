import "server-only";
import { eq } from "drizzle-orm";
import type { Session } from "next-auth";
import { headers } from "next/headers";
import { isIP } from "node:net";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { getWebEnv } from "@/env";
import type { Actor, RequestMeta } from "@/jobs/service";
import { isFetchSiteAllowed, isSameOrigin } from "@/lib/origin";

/** Origin wajib = AUTH_URL (fail-closed, melengkapi cek bawaan Server Action Next.js). */
export async function assertSameOrigin(): Promise<boolean> {
  const h = await headers();
  return isSameOrigin(h.get("origin"), getWebEnv().AUTH_URL) && isFetchSiteAllowed(h.get("sec-fetch-site"));
}

/** IP klien dari header yang diset Traefik (X-Real-Ip / X-Forwarded-For pertama); hanya IP valid. */
export async function requestMeta(): Promise<RequestMeta> {
  const h = await headers();
  const candidates = [h.get("x-real-ip"), h.get("x-forwarded-for")?.split(",")[0]?.trim()];
  const ip = candidates.find((c): c is string => typeof c === "string" && isIP(c) !== 0) ?? null;
  const rid = h.get("x-request-id");
  return { ip, requestId: rid && /^[A-Za-z0-9-]{1,64}$/.test(rid) ? rid : null };
}

export async function actorFromSession(session: Session): Promise<Actor | null> {
  const sub = session.user?.id;
  if (typeof sub !== "string" || !/^[A-Za-z0-9._:@-]{1,128}$/.test(sub)) return null;
  const rows = await getDb().select({ id: users.id }).from(users).where(eq(users.keycloakSub, sub)).limit(1);
  return { sub, userId: rows[0]?.id ?? null, roles: session.roles };
}
