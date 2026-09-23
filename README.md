# control-plane

Control plane platform multi-client (subscription, invoice transfer manual, domain, environment
Odoo, antrean provisioning). Scaffold T12 — `docs/plans/02-platform-bringup.md` (repo `infra`).

| Komponen | Versi (pin exact) | Catatan |
|---|---|---|
| Node.js | `node:24.21.0-alpine@sha256:ebfe2f90…` (Alpine 3.24, semua stage) | revisi ADR 0001 (bookworm-slim → alpine) |
| Next.js | `16.3.6` (App Router, Turbopack, `output: 'standalone'`) | `proxy.ts` (bukan `middleware.ts`) |
| Auth.js | `next-auth@5.0.0-beta.32` (`@auth/core 0.41.3`) | peer `next ^16`; v5 masih beta (dist-tag `beta`) |
| Drizzle | `drizzle-orm 0.45.3`, `drizzle-kit 0.31.11`, `pg 8.23.0` | |
| Queue | `pg-boss 12.33.6` (MIT) | schema `pgboss` di DB `control_plane` |
| Lain | `zod 4.6.5`, `pino 10.3.1`, `tailwindcss 4.3.3`, `vitest 5.0.1`, `@playwright/test 1.63.0`, `typescript 6.0.3` (typescript-eslint butuh `<6.1`), `eslint 9.39.5` | |

## Struktur

```
src/
  env.ts                 validasi env Zod (web & worker); gagal cepat saat boot
  instrumentation.ts     memanggil validasi env saat server start (exit 1 bila invalid)
  proxy.ts               nonce + CSP + X-Request-Id per request (Next 16 "proxy")
  auth.ts                Auth.js OIDC Keycloak, role dari klaim ID token
  lib/roles.ts           role + matriks izin (default deny) — murni, diuji
  lib/access.ts, authz.ts  otorisasi server-side (requirePermission) di setiap page
  lib/slug.ts            whitelist slug ^[a-z0-9-]{3,30}$
  db/schema.ts           skema Drizzle; db/migrate.ts = runner migrasi
  worker/                worker pg-boss (job `noop`, argumen di-whitelist Zod .strict())
  app/                   /, /login, /dashboard, /clients, /forbidden, /api/auth/*, /api/health
drizzle/                 migrasi SQL berversi (0000_init.sql)
tests/unit/              Vitest; e2e/ Playwright (smoke, skip bila PLAYWRIGHT_BASE_URL kosong)
```

## Perintah (tanpa Node di host — pakai container)

```bash
alias nrun='docker run --rm -v "$PWD":/app -w /app -e NEXT_TELEMETRY_DISABLED=1 node:24.21.0-alpine'
nrun npm ci
nrun npm run lint        # eslint flat config (next core-web-vitals + typescript), 0 warning
nrun npm run typecheck   # next typegen && tsc --noEmit
nrun npm test            # vitest
nrun npm run build       # next build (standalone) + esbuild worker & migrate → dist/
nrun npm audit --audit-level=high
nrun npm run db:generate -- --name <nama>   # setelah ubah src/db/schema.ts
```

## Konfigurasi

Salin `.env.example` → `.env`, `chmod 600`. `.env` tidak pernah di-commit. Variabel:
`DATABASE_URL`, `AUTH_SECRET` (≥32 char, `openssl rand -base64 48`), `AUTH_URL`,
`AUTH_KEYCLOAK_ID`, `AUTH_KEYCLOAK_SECRET`, `AUTH_KEYCLOAK_ISSUER`, `LOG_LEVEL`.
Tidak ada `NEXT_PUBLIC_*` bersecret (ditolak `env.ts`).

## Image, migrasi, jalan lokal

```bash
docker build -t control-plane:0.1.0-scaffold .
docker compose run --rm migrate          # terapkan ./drizzle ke DB (network db)
docker compose up -d web worker          # tanpa publish port; web di db+proxy, worker di db
docker compose ps                        # (healthy)
docker run --rm --network db curlimages/curl:8.22.0 -sI http://control-plane:3000/   # 307 → /login + CSP
```

Satu image, tiga command: `node server.js` (web, default), `node dist/worker/index.mjs`,
`node dist/db/migrate.mjs`. Runner: uid 1001 non-root, npm dihapus, rootfs read-only
(tmpfs `/tmp`, `/app/.next/cache`), `cap_drop: ALL`, `no-new-privileges`, HEALTHCHECK
`/api/health` (web) / heartbeat file (worker).

## Auth & otorisasi

- OIDC Authorization Code + **PKCE S256** + `state` + `nonce`; client confidential.
- Callback: `https://<host>/api/auth/callback/keycloak` (basePath default next-auth `/api/auth`).
- Cookie: `__Secure-authjs.session-token` / `__Host-authjs.csrf-token` — `HttpOnly; Secure; SameSite=Lax`.
- Role: client role Keycloak pada client `control-plane` → klaim ID token
  `resource_access.control-plane.roles` → `superadmin | ops | client_admin | client_user`.
  Role lain diabaikan. Otorisasi server-side di setiap page (`requirePermission`), bukan di proxy.
- Logout: hapus sesi lokal → redirect ke end-session Keycloak (`client_id` +
  `post_logout_redirect_uri=<AUTH_URL>/login`, Keycloak menampilkan konfirmasi).

### Client Keycloak `control-plane`

**Sudah dibuat** di realm `platform` (confidential, standard flow saja, PKCE S256, redirect/post-logout/
web origins eksak ke `https://cp.bimacreative.tech`, `fullScopeAllowed=false`, client role
`superadmin|ops|client_admin|client_user`, mapper User Client Role → ID/access/userinfo token).
Detail & prosedur: `docs/03-operations/keycloak.md` di repo infra. Secret hanya di `.env` (600).

Untuk staging (T16): buat client setara di realm `platform-staging` dengan host
`cp.staging.bimacreative.tech` (redirect `…/api/auth/callback/keycloak`, post-logout `…/login`),
lalu isi `AUTH_KEYCLOAK_ISSUER=https://auth.bimacreative.tech/realms/platform-staging` dan secret-nya
di `.env` staging.

## Kebutuhan deploy T16

- DNS: `cp.staging.bimacreative.tech` / `cp.bimacreative.tech` A → `31.97.50.221`, tanpa AAAA (pre-check `dig` sebelum router).
- Router Traefik `dynamic/platform/cp.yml` → `http://control-plane:3000`, middleware `crowdsec`,
  `security-headers`, `ratelimit-default`; router terpisah `PathPrefix(/api/auth)` dengan `ratelimit-login`;
  `certResolver: le-http-staging` dulu. Traefik tidak menset CSP (tidak bentrok dengan CSP nonce aplikasi).
- Container `web` di network `proxy` (Traefik + egress ke `auth.bimacreative.tech`) dan `db`; `worker` hanya `db`.
- Staging butuh DB/role terpisah (mis. `control_plane_staging`) + baris `pg_hba` — dikerjakan infra.
- Env per lingkungan: `AUTH_URL`, `AUTH_KEYCLOAK_ISSUER` (`…/realms/platform-staging` untuk staging),
  client Keycloak per realm, `AUTH_SECRET` berbeda.
- Panggilan token server→Keycloak lewat URL publik terkena `ratelimit-login` (10/menit/IP sumber) —
  lihat catatan `keycloak.md` §Info untuk T12.
