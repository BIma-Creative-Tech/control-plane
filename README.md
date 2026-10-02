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
drizzle/                 migrasi SQL berversi (0000_init.sql, 0001_infra_jobs.sql — additive)
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
# Varian tanpa npm ci (node_modules checkout utama di-mount read-only, mis. dari worktree): image glibc
# (node:24.21.0-bookworm-slim, bukan alpine), tmpfs untuk cache vite, dan vitest wajib `--configLoader runner`:
#   docker run --rm --network none -v "$PWD":/app -v /opt/src/control-plane/node_modules:/app/node_modules:ro \
#     --tmpfs /app/node_modules/.vite-temp --tmpfs /app/node_modules/.vite -w /app node:24.21.0-bookworm-slim \
#     npx vitest run --configLoader runner
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

## Job Odoo/SSO lewat `infra-job` (plan 05, ADR 0009)

Control plane **tidak** punya Docker API, SSH, sudo, `child_process`, atau akses secret. Alur:

```
Server Action (ops/superadmin) ─ Zod + otorisasi + kuota ─▶ 1 transaksi: INSERT provision_jobs (queued)
   + tenant_user_access + audit_logs(job.enqueue.<type>) + pesan pg-boss `infra-job-dispatch` (retryLimit 0)
worker ─ validasi ulang kontrak ─▶ status dispatched ─▶ spool/tmp/<id>.json → rename → spool/new/<id>.json
dispatcher root (host) ─▶ results/<id>.json (running → succeeded|failed + error_code, RESULT allowlist, tail)
worker collector (tiap INFRA_JOBS_POLL_SECONDS) ─▶ provision_jobs final + environments/tenant_user_access
   dari RESULT + audit_logs(job.finish); watchdog: lewat deadline → failed `no_result`
```

- Kontrak (tipe, regex, format file job/hasil, error_code, timeout): `src/lib/job-contract.ts`; fixture bersama
  dengan dispatcher: `tests/fixtures/infra-job/*.json`.
- Satu job aktif per (environment, type): partial unique index `provision_jobs_one_active_uq`.
- Kuota CP = kuota dispatcher (60/jam, `odoo_db_provision` 3/hari, `odoo_sso_user` 30/jam, `rotate_secret` 5/hari)
  + 10 job/menit per aktor. Origin wajib = `AUTH_URL` untuk semua Server Action mutasi.
- Halaman: `/clients/<slug>`, `/environments/<id>` (aksi + pengguna SSO + audit), `/jobs`, `/jobs/<id>`.
  `superadmin` saja: hapus route, nonaktifkan SSO, rotasi secret (ketik slug), ulang `timeout_state_unknown`,
  tambah client/environment.
- `users` di-upsert saat login (keycloak_sub, email, role cache, last_login_at).
- Identitas aktor = klaim `sub` Keycloak (QA J5 BUG-J5-02): callback `jwt` menimpa `token.sub` (Auth.js
  mengisi UUID acak per login) dengan `profile.sub` + penanda `kcSub`; `provision_jobs.actor` / `audit_logs.actor`
  = `user:<sub Keycloak>`, `actor_user_id` = `users.id` (baris minimal dibuat bila upsert login gagal).
  **Sesi lama** (dibuat sebelum perubahan ini, tanpa `kcSub`) tetap bisa melihat halaman, tetapi setiap aksi
  mutasi dijawab `?r=reauth` ("logout lalu login ulang"); sesi kedaluwarsa sendiri ≤ 8 jam.
- `odoo_sso_user resend_invite` (BUG-J5-01): hanya untuk baris `tenant_user_access` berstatus `active` — tombol
  disembunyikan untuk status lain DAN server menolak (`?r=precondition`, audit `detail=user_not_active`), juga
  dry-run/ulangi. Status baris diturunkan dari RESULT `action=` (grant → active, revoke → revoked,
  resend_invite → tidak berubah). RESULT `action` ≠ aksi diminta (atau hilang pada apply sukses) → job
  `failed`/`result_inconsistent`, baris `inconsistent`, audit `job.result_inconsistent` (actor `system:worker`,
  tanpa email) + log error `alert=job_result_inconsistent`. Perbaikan: revoke atau grant eksplisit.
- RESULT `invite=` (`sent`/`none`) ditampilkan di detail job sebagai fakta undangan; redaksi tail tidak dilonggarkan.
- Mutasi (POST ke halaman/Server Action) dengan header `Origin` asing → `403` di `proxy.ts` sebelum Next.js
  (bukan 500), tanpa baris job. Tanpa header Origin → tetap 303 `?r=origin` dari action.

| Env | Proses | Keterangan |
|---|---|---|
| `INFRA_JOBS_INSTANCE` | web + worker | `prod` (env tenant prod/demo) atau `staging`; kosong = fitur nonaktif |
| `INFRA_JOBS_SPOOL_DIR` | worker | path di container untuk `/var/lib/infra-jobs/<inst>/spool` (rw), berisi `tmp/`, `new/` |
| `INFRA_JOBS_RESULTS_DIR` | worker | path di container untuk `/var/lib/infra-jobs/<inst>/results` (ro) |
| `INFRA_JOBS_POLL_SECONDS` | worker | default 5 |
| `INFRA_JOBS_QUEUE_GRACE_SECONDS` | worker | default 900 (antrean serial dispatcher sebelum `no_result`) |

Tanpa `INFRA_JOBS_SPOOL_DIR/RESULTS_DIR/INSTANCE` worker berjalan seperti sebelumnya (hanya `noop`).

## Users & job identitas (SaaS Fase 1, kontrak infra `docs/plans/saas-phase-1-contract.md`)

- Migrasi `0004_saas_p1_users` (aditif): `job_type` += 10 tipe (`kc_*`, `odoo_user_ensure`, `odoo_tenant_config`,
  `tenant_suspend|resume`); `clients` += `status`, `isolation`, `brand`, `kc_org_id`, `is_platform` (≤ 1 baris platform);
  `users` += `status` (`invited|active|disabled`), `invited_by`, `disabled_at` (≤ 1 `client_admin` invited/active per tenant);
  `provision_jobs` += `idempotency_key` (unik), `after_job_id`, `chain_id`; error_code += `chain_aborted`.
- Tenant internal `platform` (`is_platform=true`) dibuat idempoten oleh `node dist/db/migrate.mjs` setelah migrasi; slug
  `platform` ditolak form Tambah client; tenant platform tidak punya environment Odoo.
- **Allowlist tipe per instance**: env `INFRA_JOBS_TYPES` (web + worker, dipisah koma) = cermin `job_types` di
  `/etc/infra-jobs/<inst>.conf`. Kosong = 5 tipe plan 05 → halaman `/users` read-only. Staging Fase 1: isi semua tipe.
- `/users` (`users:view` = superadmin+ops; aksi `users:manage` = superadmin; `users:manage_own` = **default-deny untuk
  semua role** sampai portal tenant W6 — jalur kode cakupan tenant sendiri tetap ada + diuji): filter tenant (termasuk `platform`), Tambah user (rantai `[kc_org_ensure] →
  kc_user_ensure → kc_user_set_roles → odoo_user_ensure` per env berakses), Nonaktifkan/Aktifkan, Ubah role/akses Odoo,
  Kirim reset password; status rantai per langkah. Label role: superadmin=platform-admin, ops=platform-viewer,
  client_admin=tenant-admin, client_user=tenant-user. Nama user: ASCII saja (non-ASCII ditolak, sama dengan dispatcher).
- **Pengikatan email** (temuan QA F1): setiap mutasi ditolak bila email yang sama sudah ada di `users` sebagai baris lama
  tanpa tenant (`email_unbound`), ber-role superadmin/ops untuk tenant klien (`email_platform_role`), atau milik tenant
  lain (`email_other_tenant`). Baris lama `client_id IS NULL` diikat lewat aksi superadmin **"Ikat ke tenant…"** →
  `kc_user_ensure adopt=true` (kontrak v1.2, tanpa undangan) → `kc_user_set_roles` (platform: role cache tetap
  superadmin/ops; tenant klien: hanya tenant-admin/tenant-user, tidak pernah untuk role cache platform). `adopt=true` dari
  aktor tanpa `users:manage` ditolak + diaudit di `enqueueChain`, dan worker menolak (`rejected_validation`, `adopt_actor`)
  job adopt yang aktornya bukan superadmin. Rekonsiliasi hanya mengisi `users.client_id` baris lama bila `adopt=true` (audit
  `user.adopt_bound`) atau RESULT `created=1`; selain itu `user.reconcile_conflict` `unbound_without_adopt`.
- **Satu tenant-admin atomik** (temuan QA F2): rantai yang memuat `kc_user_set_roles cp_role=client_admin` mengambil
  `pg_advisory_xact_lock(hashtext('tenant-admin:'||client_id))` di transaksi enqueue lalu ditolak (`one_admin`) bila sudah
  ada `client_admin` invited/active atau job set_roles client_admin aktif (email lain) untuk tenant itu.
- Rantai: hanya kepala yang dikirim ke pg-boss; langkah berikut di-dispatch worker (`advanceChains`) setelah pendahulu
  `succeeded`; pendahulu `failed|cancelled` → `cancelled`/`chain_aborted` + audit `job.chain_aborted`. Idempotency:
  `<type>:<slug>:<env>:<email|org|realm|tenant>` — job aktif dengan args sama dipakai ulang, args beda → `duplicate`;
  job final melepas kuncinya.
- Rekonsiliasi dari RESULT: `kc_user_ensure` → baris `users` (sub = `kc_user`, `invited`), `kc_user_set_roles` → cache
  role, `kc_user_set_enabled` → `active|disabled` (+`disabled_at`), `odoo_user_ensure` → `tenant_user_access`,
  `kc_org_ensure` → `clients.kc_org_id`. Login pertama → `invited → active`.
- **Baris `users` tidak pernah dihapus** — sejak migrasi `0005` FK `audit_logs.actor_user_id` /
  `provision_jobs.actor_user_id` = `ON DELETE RESTRICT` (DB menolak DELETE user beraudit) — lihat
  `docs/temuan-users-prod-kosong.md`.

## Subscriptions & Invoices (SaaS Fase 1 W5/W7, ADR 0018 infra)

- Migrasi `0005_saas_p1_billing` (aditif): `subscription_status` += `implementation|warranty|past_due` (`pending`/`grace`
  usang — tidak ditulis kode baru; default kolom DB tetap `pending`, kode selalu mengisi status eksplisit);
  `subscriptions` += `go_live_at`, `warranty_until` (date WIB), `notes`, `price_amount` + `price_currency` (override harga
  per langganan, NULL = harga plan; CHECK ≥ 0 dan mata uang wajib bersama harga); `plans` += `service` (`odoo|insight|mail|web`),
  `price_amount` nullable; `invoices` += `kind` (`implementation|maintenance`, default maintenance), `proof_reference`,
  `period_start/period_end` (+ unik satu invoice maintenance non-void per (subscription, periode)); `domains` += `purpose`,
  `dkim_txt`, `last_check`; `environments.tenant_check`; tabel `notification_log`; FK aktor audit/job → RESTRICT.
- Langkah boot `migrate.mjs`: 7 plan ADR 0018 D7 (`odoo-shared-s|m`, `odoo-dedicated`, `mail-5|20`, `web-profile`,
  `insight-basic`), harga NULL, bulanan — idempoten, plan yang sudah ada tidak diubah.
- Tanggal bisnis = kalender Asia/Jakarta; `current_period_start/end` (= starts_at/ends_at) dan `grace_until` disimpan
  00:00 WIB. Logika murni + tabel transisi: `src/lib/billing.ts` (diuji unit).
- `/subscriptions` (lihat `billing:view` = superadmin+ops; buat/Go-live/akhiri `billing:manage` = superadmin) dan
  `/invoices` (terbitkan/void `billing:manage`; tandai lunas `invoices:confirm` = superadmin+ops: tanggal bayar,
  referensi transfer, referensi bukti — tanpa upload Fase 1). Nomor `INV/YYYY/MM/NNNN` (urut per bulan terbit WIB,
  advisory lock + unique index). Semua mutasi diaudit. Ringkasan tenant yang bisa disematkan:
  `src/app/billing/tenant-billing.tsx` (`TenantBillingSummary`) + `src/server/billing-queries.ts`.
- **Harga invoice maintenance otomatis** (keputusan Lead integrasi): override langganan (`subscriptions.price_amount`,
  diisi saat buat langganan atau "Ubah harga…" di `/subscriptions`, superadmin, audit `subscription.price`) → selain itu
  harga plan → keduanya NULL: tidak diterbitkan, audit `price_missing` (`lib/billing.ts` `effectivePrice`).
- Lunas invoice maintenance → periode +1 (starts = ends lama), status `active`, invoice periode berikut (bila ada
  harga efektif); dari `suspended` + layanan Odoo → `tenant_resume` per env instance (outbox, transaksi sama).
- **`subscription_tick`** (worker, pg-boss schedule `15 0 * * *` tz `Asia/Jakarta`, `missed: once`, antrean exclusive):
  warranty → active (+ invoice maintenance pertama), active → past_due (grace +2 bulan), past_due → suspended
  (+ `tenant_suspend` per env instance dengan route aktif: prod-inst prod+demo, staging-inst staging; idempotency key
  `tenant_suspend:<slug>:<env>:tenant`; layanan Odoo saja). implementation/warranty tidak pernah disuspend otomatis.
  Gagal enqueue (kuota/duplikat) → transisi di-rollback, dicoba tick berikutnya. Cek harian tenant-admin (≥ 1
  client_admin invited/active per tenant non-platform): audit `tenant.admin_missing` harian; email ke billing **hanya bila
  himpunan tenant tanpa admin berubah** dibanding notifikasi terakhir (sidik sha256 id terurut di kunci
  `notification_log` `admin_check:<tanggal>:<sidik>`; himpunan kembali kosong → penanda `…:none` tanpa email).
- Rekonsiliasi RESULT: `tenant_suspend|resume` `state=suspended|active` → `clients.status`; `odoo_tenant_config`
  `mode` → `environments.tenant_check`.
- `/suspended` dan `/suspended/<slug>`: publik, statis, tidak membaca DB/sesi/slug (respons identik), CSP sama.

| Env (worker) | Keterangan |
|---|---|
| `TICK_NOW` | `YYYY-MM-DD`, **hanya** dibaca bila `INFRA_JOBS_INSTANCE=staging` (di instance lain diabaikan + warn); staging + TICK_NOW → satu tick saat boot |
| `SMTP_HOST`, `SMTP_PORT` (587) | kosong = email nonaktif (tick tetap jalan) |
| `SMTP_USER` + `SMTP_PASSWORD_FILE` | berpasangan; password hanya dari file secret (dibaca saat kirim) |
| `SMTP_TLS` | `required` (default: 465 TLS implisit, lain STARTTLS wajib) / `off` (**hanya** staging, Mailpit) |
| `SMTP_FROM`, `BILLING_EMAIL` | default `noreply@bimacreative.tech`, `billing@bimacreative.tech` |

Pengingat (teks polos): H-14 sebelum `warranty_until`, H+0/H+14/H+45 setelah `ends_at` — ke tenant-admin (cc billing;
tanpa admin → billing saja), idempoten per (subscription, jenis, periode) di `notification_log` (gagal → dicoba ulang
≤ 3 kali; `pending` tidak dikirim ulang). Dependensi baru: `nodemailer 10.0.10` (MIT-0, tanpa dependensi; hanya worker).

### Test integrasi (Postgres sekali pakai — skema di-DROP)

```bash
docker network create cp-int-test
docker run -d --name cp-int-pg --network cp-int-test -e POSTGRES_PASSWORD=testonly -e POSTGRES_DB=cp_test postgres:16.15-bookworm
docker run --rm --network cp-int-test -v "$PWD":/app -w /app \
  -e TEST_DATABASE_URL=postgresql://postgres:testonly@cp-int-pg:5432/cp_test node:24.21.0-alpine npm run test:integration
docker rm -f cp-int-pg && docker network rm cp-int-test
```

Email (opsional, `tests/integration/billing-flow.test.ts`): Mailpit sekali pakai di network yang sama
(`docker run -d --name cp-int-mailpit --network cp-int-test -e MP_SMTP_AUTH_ACCEPT_ANY=1 -e MP_SMTP_AUTH_ALLOW_INSECURE=1
axllent/mailpit:v1.31.2`) + `-e TEST_MAILPIT_SMTP=cp-int-mailpit:1025 -e TEST_MAILPIT_API=http://cp-int-mailpit:8025`.
Tanpa itu, uji email memakai mailer perekam.

## Tenant, Audit, Realm (SaaS Fase 1 W5)

- **"Tenant baru"** di `/clients` (superadmin, `clients:manage`; aktif bila allowlist instance memuat semua tipe
  onboarding): slug (bukan `platform`), nama, brand, email+nama tenant-admin (nama ASCII), environment instance ini
  (prod-inst: `prod` + opsional `demo` dengan host; staging-inst: `staging`), override host (aturan HOST job-contract).
  SATU transaksi: INSERT `clients` + `environments` (logika = "Tambah environment") + audit `tenant.create` + SATU rantai:
  `kc_org_ensure` → per env `odoo_db_provision → odoo_route → odoo_sso_provision → odoo_tenant_config(compat)` →
  `kc_user_ensure(invite)` → per env `kc_user_set_roles(client_admin, odoo=admin)` → per env `odoo_user_ensure(admin)`.
  Slug/DB/host terpakai, email F1, kuota → ditolak utuh (tanpa baris tersisa), diaudit. **Plan Odoo opsional** (plan
  aktif layanan `odoo`, butuh juga `billing:manage`): langganan `implementation` dibuat di transaksi yang sama
  (`createSubscriptionTx`, audit `subscription.create`); plan tidak ada/nonaktif/bukan odoo → `plan_inactive`, ditolak utuh.
- **Rantai + tipe lama**: `odoo_db_provision|odoo_route|odoo_sso_provision` boleh di rantai; `environment_id` diturunkan
  server dari (client, env) → ikut `provision_jobs_one_active_uq`; job aktif (environment, type) args sama dipakai ulang,
  args beda → `duplicate`. Aksi berisiko butuh `jobs:odoo_admin`; `odoo_sso_user|odoo_sso_disable` tidak boleh di rantai.
  Host SSO ⊆ route (rantai/DB) dicek saat enqueue DAN ulang oleh worker saat dispatch (`host_not_in_route`). Maks 20
  langkah; kuota rantai += `odoo_db_provision` 3/hari.
- **`/clients/<slug>`**: status tenant, environment (db/route/sso/`tenant_check` = kolom `environments.tenant_check` dari
  RESULT `mode` job `odoo_tenant_config`),
  user tenant (link `/users?tenant=`), rantai + 10 job terakhir, **Suspend/Resume** (superadmin, ketik slug →
  `tenant_suspend|tenant_resume` per env instance ini; kebalikan aktif → `state_busy`), **"Ulangi dari langkah ini"**
  (superadmin; hanya rantai `tenant.*`/`realm.*`/`chain.retry`; ditolak bila user target kini `disabled` atau akun aktor
  sendiri), ringkasan langganan & invoice terbuka (`TenantBillingSummary`, `billing:view`). `clients.status` TIDAK diubah
  di sini.
- **`/audit`** (superadmin+ops, `audit:view`): filter aktor (prefix sub), tenant, aksi (prefix, `starts_with`), hasil,
  rentang tanggal UTC, 50/halaman. Email tidak pernah tampil (tanpa join `users.email`; metadata disamarkan).
- **`/realm`** (superadmin, `realm:sync`): "Rencana sync realm" (`kc_realm_sync` dry-run, slug `platform`, env realm
  instance) → RESULT changed/blockers; "Terapkan" = ketik nama realm + rencana sukses ≤ 24 jam tanpa blocker; prod/demo
  hanya dengan checkbox persetujuan → `approve=true`. Daftar `users` tanpa tenant → "Ikat ke tenant…" di `/users`.

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
