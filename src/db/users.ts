import { sql } from "drizzle-orm";
import type { Db } from "./client";
import { users } from "./schema";
import { primaryRole, type Role } from "../lib/roles";

const EMAIL_MAX = 254;
const NAME_MAX = 200;

export interface LoginProfile {
  sub: string;
  email?: unknown;
  name?: unknown;
  roles: readonly Role[];
}

/** Nilai kolom `users` dari klaim login (murni, diuji unit). */
export function loginUserValues(p: LoginProfile, now: Date) {
  const email =
    typeof p.email === "string" && p.email.length <= EMAIL_MAX && p.email.includes("@") ? p.email.toLowerCase() : null;
  const displayName = typeof p.name === "string" ? p.name.slice(0, NAME_MAX) : null;
  return { keycloakSub: p.sub, email, displayName, role: primaryRole(p.roles), lastLoginAt: now };
}

/**
 * Upsert `users` saat login (plan 05 §7, prasyarat audit actor_user_id & iterasi 2). `client_id` TIDAK
 * disentuh (binding user↔client dikelola superadmin). Role = cache; otorisasi tetap dari klaim sesi.
 */
export async function upsertUserOnLogin(db: Db, p: LoginProfile, now = new Date()): Promise<string | null> {
  if (!/^[A-Za-z0-9._:@-]{1,128}$/.test(p.sub)) return null;
  const v = loginUserValues(p, now);
  const rows = await db
    .insert(users)
    .values(v)
    .onConflictDoUpdate({
      target: users.keycloakSub,
      set: { email: v.email, displayName: v.displayName, role: v.role, lastLoginAt: now, updatedAt: sql`now()` },
    })
    .returning({ id: users.id });
  return rows[0]?.id ?? null;
}
