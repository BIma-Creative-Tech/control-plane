/**
 * Identitas stabil user = klaim `sub` Keycloak (BUG-J5-02). Modul murni (tanpa Next/Auth.js) — diuji unit.
 *
 * Auth.js 5 (@auth/core 0.41.3, lib/actions/callback/oauth/callback.js `getUserAndAccount`) sengaja men-set
 * `user.id = crypto.randomUUID()` per login, dan callback JWT default memakai `token.sub = user.id`. Akibatnya
 * `session.user.id` berubah tiap login dan tidak bisa dicocokkan ke Keycloak. Di sini `token.sub` ditimpa
 * dengan `profile.sub` (klaim ID token tervalidasi; = `account.providerAccountId` untuk provider Keycloak,
 * @auth/core/lib/utils/providers.js defaultProfile `id: profile.sub`) dan ditandai `kcSub`.
 *
 * Sesi lama (dibuat sebelum perbaikan ini) tidak punya `kcSub` → `sessionUserId()` = null → aksi mutasi
 * ditolak dengan kode `reauth` (user harus login ulang; sesi maksimal 8 jam).
 */

/** Sama dengan ACTOR_REGEX (job-contract) tanpa prefiks `user:` — UUID Keycloak lolos, juga id federasi `f:<id>:<user>`. */
export const SUB_REGEX = /^[A-Za-z0-9._:@-]{1,128}$/;

export function isValidSub(v: unknown): v is string {
  return typeof v === "string" && SUB_REGEX.test(v);
}

/**
 * `sub` Keycloak saat sign-in. Wajib dari `profile.sub`; bila `account.providerAccountId` ada, harus sama
 * (pertahanan: provider profile() kustom yang menimpa id). Tidak valid → null (login tetap jalan, tetapi
 * sesi tidak punya identitas aktor → tidak bisa memicu aksi).
 */
export function subFromSignIn(profile: unknown, account: unknown): string | null {
  const sub = typeof profile === "object" && profile !== null ? (profile as Record<string, unknown>).sub : undefined;
  if (!isValidSub(sub)) return null;
  const pa = typeof account === "object" && account !== null ? (account as Record<string, unknown>).providerAccountId : undefined;
  if (pa !== undefined && pa !== sub) return null;
  return sub;
}

/** Terapkan identitas sign-in ke token JWT (dipanggil di callback `jwt` saat `account && profile`). */
export function applySignInIdentity<T extends Record<string, unknown>>(token: T, sub: string | null): T {
  const t = token as Record<string, unknown>;
  if (sub) {
    t.sub = sub;
    t.kcSub = sub;
  } else {
    // Jangan biarkan UUID acak Auth.js tampil sebagai identitas.
    delete t.sub;
    delete t.kcSub;
  }
  return token;
}

/** `session.user.id` = `kcSub` token; token lama (tanpa `kcSub`) → null. */
export function sessionUserId(token: Record<string, unknown>): string | null {
  const k = token.kcSub;
  if (!isValidSub(k)) return null;
  // Token yang dimanipulasi tidak mungkin (JWE ditandatangani AUTH_SECRET), tapi tetap konsisten: sub == kcSub.
  return token.sub === k ? k : null;
}
