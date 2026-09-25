/**
 * Auth.js v5 (next-auth 5.0.0-beta.32) — OIDC Keycloak.
 * Diverifikasi dari source terpasang:
 * - basePath default `/api/auth` (next-auth/lib/env.js) → callback `/api/auth/callback/keycloak`.
 * - checks default OIDC = ["pkce"] + "state" (@auth/core/lib/utils/providers.js); di sini eksplisit
 *   ditambah "nonce".
 * - `profile` pada callback jwt = klaim ID token tervalidasi (@auth/core/.../oauth/callback.js).
 * - Cookie sesi: httpOnly, sameSite "lax", secure + prefix __Secure- bila useSecureCookies
 *   (@auth/core/lib/utils/cookie.js defaultCookies).
 * Konfigurasi lazy (fungsi) agar `next build` tidak membutuhkan secret.
 */
import NextAuth from "next-auth";
import Keycloak from "next-auth/providers/keycloak";
import { getDb } from "@/db";
import { safeErrorMessage } from "@/db/errors";
import { upsertUserOnLogin } from "@/db/users";
import { getWebEnv } from "@/env";
import { applySignInIdentity, sessionUserId, subFromSignIn } from "@/lib/identity";
import { logger } from "@/lib/logger";
import { extractRoles, isRole, type Role } from "@/lib/roles";

declare module "next-auth" {
  interface Session {
    roles: Role[];
  }
}

const SESSION_MAX_AGE_SECONDS = 8 * 60 * 60;

export const { handlers, auth, signIn, signOut } = NextAuth(() => {
  const env = getWebEnv();
  return {
    providers: [
      Keycloak({
        clientId: env.AUTH_KEYCLOAK_ID,
        clientSecret: env.AUTH_KEYCLOAK_SECRET,
        issuer: env.AUTH_KEYCLOAK_ISSUER,
        checks: ["pkce", "state", "nonce"],
      }),
    ],
    secret: env.AUTH_SECRET,
    session: { strategy: "jwt", maxAge: SESSION_MAX_AGE_SECONDS },
    useSecureCookies: env.AUTH_URL.startsWith("https://"),
    pages: { signIn: "/login", error: "/login" },
    callbacks: {
      async jwt({ token, account, profile }) {
        // Hanya saat sign-in: ambil role dari klaim ID token (sumber kebenaran = Keycloak).
        if (account && profile) {
          const roles = extractRoles(profile, env.AUTH_KEYCLOAK_ID);
          token.roles = roles;
          // BUG-J5-02: identitas = `sub` Keycloak (bukan UUID acak Auth.js per login) — lihat lib/identity.ts.
          const sub = subFromSignIn(profile, account);
          applySignInIdentity(token, sub);
          if (!sub) logger.warn("klaim sub Keycloak tidak valid saat login; sesi tanpa identitas aktor");
          // Plan 05 §7: upsert `users` (keycloak_sub, email, role cache, last_login_at) — untuk audit
          // actor_user_id & iterasi 2. Gagal DB tidak memblokir login (otorisasi tetap dari klaim).
          if (sub) {
            try {
              await upsertUserOnLogin(getDb(), { sub, email: profile.email, name: profile.name, roles });
            } catch (err) {
              logger.warn({ err: safeErrorMessage(err) }, "upsert users saat login gagal");
            }
          }
        }
        return token;
      },
      session({ session, token }) {
        // Hanya field aman yang dikirim ke browser (/api/auth/session). Tanpa token OIDC.
        const raw = token.roles;
        session.roles = Array.isArray(raw) ? raw.filter(isRole) : [];
        // Hanya `sub` Keycloak (kcSub); token lama tanpa kcSub → tanpa id → aksi mutasi minta login ulang.
        const id = sessionUserId(token);
        if (session.user) {
          if (id) session.user.id = id;
          else delete (session.user as { id?: string }).id;
        }
        return session;
      },
    },
  };
});

/** URL end-session Keycloak (dari discovery realm). Tanpa id_token_hint → Keycloak minta konfirmasi. */
export function keycloakLogoutUrl(): string {
  const env = getWebEnv();
  const url = new URL(`${env.AUTH_KEYCLOAK_ISSUER.replace(/\/$/, "")}/protocol/openid-connect/logout`);
  url.searchParams.set("client_id", env.AUTH_KEYCLOAK_ID);
  url.searchParams.set("post_logout_redirect_uri", new URL("/login", env.AUTH_URL).toString());
  return url.toString();
}
