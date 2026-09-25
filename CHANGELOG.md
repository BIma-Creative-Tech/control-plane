# Changelog

Semua perubahan penting pada repo `control-plane` dicatat di file ini.

Format mengikuti [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), dan proyek ini memakai
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Versi ada di `package.json`; tag git `vX.Y.Z` (annotated).
Image dibangun lokal di VPS dengan tag short SHA commit (`control-plane:<sha7>`) — **TEMPORARY** sampai GHCR/CI deploy
(infra `docs/03-operations/control-plane.md`).

## [Unreleased]

## [0.2.0] - 2026-09-25

Jembatan job Odoo/SSO ke host lewat dispatcher root `infra-job` (infra plan 05, ADR 0009). Commit `4fc3828` → `6d94d2b`;
image `control-plane:6d94d2b` berjalan di prod (`cp.bimacreative.tech`) dan staging (`cp.staging.bimacreative.tech`) sejak
2026-09-25.

### Added
- Migrasi `0001_infra_jobs` (additive, `a727ddc`): `job_type` + `odoo_db_provision`, `odoo_route`, `odoo_sso_provision`,
  `odoo_sso_disable`, `odoo_sso_user`; `job_status` + `dispatched`; kolom `provision_jobs` (`environment_id`, `env`, `dry_run`,
  `exit_code`, `error_code` + CHECK, `result`, `parent_job_id`, `dispatched_at`, `deadline_at`) dan partial unique index satu job
  aktif per (environment, type); kolom `environments` (`host`, `db_status`, `route_status`, `sso_status`, `sso_client_id`,
  `sso_provider_id`, `last_job_id`); tabel `tenant_user_access`.
- Jembatan `infra-job` (`1c61472`): kontrak job `src/lib/job-contract.ts` (Zod `.strict()`, regex = dispatcher, binding
  instance→env, aturan host, builder file job v1, parser hasil dengan allowlist `RESULT` dan redaksi `tail`); `src/jobs/service.ts`
  (satu transaksi: kontrak + otorisasi aksi + prasyarat route + kuota + `provision_jobs` + `tenant_user_access` + `audit_logs` +
  pesan pg-boss); worker: antrean `infra-job-dispatch` (`retryLimit 0`), penulis spool atomik (`tmp/` → `new/`), collector hasil,
  rekonsiliasi `environments`/`tenant_user_access`, watchdog `no_result`.
- UI ops/superadmin: `/clients/<slug>`, `/environments/<id>` (aksi, pengguna SSO, job, audit), `/jobs`, `/jobs/<id>` (ulangi = job
  baru); tambah client/environment (superadmin). Aksi superadmin saja: hapus route, nonaktifkan SSO, rotasi secret (ketik slug),
  ulang `timeout_state_unknown`.
- Env `INFRA_JOBS_INSTANCE` (web + worker), `INFRA_JOBS_SPOOL_DIR`, `INFRA_JOBS_RESULTS_DIR`, `INFRA_JOBS_POLL_SECONDS`
  (default 5), `INFRA_JOBS_QUEUE_GRACE_SECONDS` (default 900); tanpa env ini fitur job nonaktif.
- Upsert `users` saat login (`keycloak_sub`, email, cache role, `last_login_at`).
- Test: fixture kontrak bersama dispatcher, unit (authz, form, kuota, Origin, rekonsiliasi), integrasi terhadap dispatcher palsu di
  Postgres nyata (`npm run test:integration`); README §Job Odoo/SSO + `.env.example` (`013de24`).
- Kode error CP `spool_error` (worker gagal menulis spool) + migrasi `0002_error_code_spool_error` (CHECK diperlebar, `7b85a78`).
- Migrasi `0003_j5_inconsistent` (additive, `a0e8f09`): `tenant_user_status` + `inconsistent`; kode error CP
  `result_inconsistent`.
- RESULT `invite=sent|none` ditampilkan di detail job (`6d94d2b`).
- CI: workflow `security.yml` (gitleaks, Semgrep, Trivy, Hadolint, build/test, image scan) (`0030d68`).

### Changed
- Validator CP diselaraskan persis dengan dispatcher (`7b85a78`): slug `^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$`, email huruf kecil
  (form me-lowercase), host `*.erp`/`*.staging.bimacreative.tech`, file job divalidasi utuh sebelum ke spool; revoke tidak mengirim
  `admin`/`create_kc`; hanya kode error dispatcher yang dipercaya dari file hasil.

### Fixed
- BUG-J5-01 (High, sisi CP, `6d94d2b`): "Kirim ulang" undangan hanya untuk baris `active` (UI + server `precondition`, diaudit);
  status `tenant_user_access` diturunkan dari `RESULT action=`; aksi hasil ≠ aksi diminta → job `failed`/`result_inconsistent`,
  baris `inconsistent`, audit `job.result_inconsistent`. (Sisi skrip diperbaiki di repo infra `3ca5501`.)
- BUG-J5-02 (Medium, `6d94d2b`): aktor = klaim `sub` Keycloak (sebelumnya UUID acak per login dari Auth.js `token.sub`);
  `actor_user_id` terisi. Sesi lama tanpa penanda `kcSub` → mutasi dijawab `?r=reauth`.
- Server Action dengan header `Origin` asing → 403 di `proxy.ts` (sebelumnya 500 dari Next.js) (`6d94d2b`).

### Security
- Control plane tetap tanpa Docker API, SSH, sudo, `child_process`, atau pembacaan secret; satu-satunya jalur ke aksi host = file
  job di spool (ditulis worker dengan uid host khusus 950/951, bukan 1001). Email di `audit_logs` di-hash (`email_hash`).
- QA staging infra `docs/qa/2026-09-25-plan05-staging.md`: 17 kasus negatif CP (role, akses halaman, Origin, injeksi, kuota) ditolak; regresi J5R
  PASS.

### Upgrade / rollback
- Migrasi 0001–0003 additive: image `4fc3828`/`7b85a78` tetap bisa berjalan di DB yang sudah dimigrasi. Backup `pg_dump` sebelum
  upgrade; langkah deploy/rollback: infra `docs/03-operations/control-plane.md` §Jembatan infra-job.
- Butuh host dengan role Ansible `infra_jobs` (spool, user `cpjob-*`) dan compose worker plan 05 (repo infra).

### Belum diverifikasi
- CI (`security.yml`) untuk commit rilis ini tidak diperiksa (infra plan 05 AC-J13).

## [0.1.0] - 2026-09-23

Tidak pernah di-tag. Scaffold awal (`74a49cb`, `dee8b71`, `4fc3828`; image `control-plane:0.1.0-scaffold` lalu
`control-plane:4fc3828`).

### Added
- Scaffold Next.js 16 + Auth.js OIDC (Keycloak) + Drizzle + worker pg-boss (`74a49cb`).
- Pre-commit hook gitleaks untuk staged changes (`4fc3828`).

### Changed
- Base image `node:24.21.0-alpine` (pin digest) (`dee8b71`).
