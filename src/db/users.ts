import { eq, sql } from "drizzle-orm";
import type { Db } from "./client";
import { users } from "./schema";
import { isValidSub } from "../lib/identity";
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
 * disentuh (binding user↔tenant hanya dari RESULT job kc_user_ensure, jobs/user-reconcile.ts). Role = cache;
 * otorisasi tetap dari klaim sesi. Login pertama user undangan (`invited`) → `active`; `disabled` tidak diubah
 * (user nonaktif tidak bisa login di Keycloak; bila status cache tertinggal, aksi mutasinya tetap ditolak).
 */
export async function upsertUserOnLogin(db: Db, p: LoginProfile, now = new Date()): Promise<string | null> {
  if (!isValidSub(p.sub)) return null;
  const v = loginUserValues(p, now);
  const rows = await db
    .insert(users)
    .values(v)
    .onConflictDoUpdate({
      target: users.keycloakSub,
      set: {
        email: v.email,
        displayName: v.displayName,
        role: v.role,
        lastLoginAt: now,
        status: sql`CASE WHEN ${users.status} = 'invited' THEN 'active'::user_status ELSE ${users.status} END`,
        updatedAt: sql`now()`,
      },
    })
    .returning({ id: users.id });
  return rows[0]?.id ?? null;
}

/**
 * users.id untuk `sub` Keycloak; baris dibuat minimal (tanpa email/nama) bila belum ada — mis. upsert saat
 * login gagal karena DB sementara tidak tersedia. Baris yang sudah ada TIDAK diubah (email/role dari login).
 */
export async function ensureUserId(db: Db, sub: string, roles: readonly Role[]): Promise<string | null> {
  if (!isValidSub(sub)) return null;
  const found = await db.select({ id: users.id }).from(users).where(eq(users.keycloakSub, sub)).limit(1);
  if (found[0]) return found[0].id;
  const ins = await db
    .insert(users)
    .values({ keycloakSub: sub, role: primaryRole(roles) })
    .onConflictDoNothing({ target: users.keycloakSub })
    .returning({ id: users.id });
  if (ins[0]) return ins[0].id;
  const again = await db.select({ id: users.id }).from(users).where(eq(users.keycloakSub, sub)).limit(1);
  return again[0]?.id ?? null;
}
