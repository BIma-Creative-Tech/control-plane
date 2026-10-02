# Changelog

Semua perubahan penting pada repo `control-plane` dicatat di file ini.

Format mengikuti [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), dan proyek ini memakai
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Versi ada di `package.json`; tag git `vX.Y.Z` (annotated).
Image dibangun lokal di VPS dengan tag short SHA commit (`control-plane:<sha7>`) — **TEMPORARY** sampai GHCR/CI deploy
(infra `docs/03-operations/control-plane.md`).

## [Unreleased]

### Added
- **Migrasi prod M8 — "Daftarkan tenant yang sudah ada"** (`/clients`, superadmin `clients:manage`; plan → juga
  `billing:manage`): tenant yang sudah hidup (DB, route — boleh host kustom —, SSO) dicatat ke `clients` +
  `environments` dengan status deklarasi (db `provisioned`, route `active`, sso `active|none`) tanpa provisioning;
  `db_name` wajib konvensi `<slug '-'→'_'>_<env>`; slug `platform`/slug terpakai/host terpakai ditolak; plan Odoo
  opsional → langganan `implementation`. Satu transaksi + audit `tenant.register_existing` (tanpa PII) + rantai
  `kc_org_ensure` [→ `odoo_tenant_config(compat)` per env ber-SSO aktif] sesuai allowlist `INFRA_JOBS_TYPES` (tidak
  diizinkan → baris data saja + pemberitahuan). Rantai ini bisa diulang dari langkah gagal.
- **Route manual** (diturunkan dari regex HOST job-contract, tanpa kolom/migrasi): environment ber-host di luar host
  platform env-nya → tombol Provision DB/route/SSO di halaman environment nonaktif ("Route manual — diadopsi di Fase
  2") dan layanan menolak `odoo_db_provision|odoo_route|odoo_sso_provision|odoo_sso_disable` (job tunggal maupun
  rantai) dengan kode `route_manual` (diaudit).
- **SaaS Fase 1 W5 — Domains**: CRUD domain per tenant di halaman tenant (superadmin, izin `domains:manage`, audit),
  tautan environment odoo/web milik tenant yang sama, DKIM untuk mail, status `pending_dns`, token verifikasi acak
  server; checklist DNS yang digenerate (A tanpa AAAA ke `PLATFORM_PUBLIC_IPV4`; MX/SPF/DKIM/DMARC untuk mail) di
  halaman tenant dan `/portal/domains`; sso tanpa record. fqdn di bawah zona platform ditolak `fqdn_platform`. Env web
  baru `PLATFORM_PUBLIC_IPV4` (opsional) dan `PLATFORM_DOMAINS` (default `bimacreative.tech`). Verifikasi otomatis = Fase 2.
- **SaaS Fase 1 W6 — Portal tenant**: `/portal` (Ringkasan read-only: environment, langganan, invoice terbuka),
  `/portal/users` (tenant-admin: tambah tenant-user, nonaktif/aktif, reset password, akses Odoo per env; batas user plan
  `plans.max_users` dengan kunci per tenant), `/portal/domains` (read-only). Izin baru `portal:view`, `portal:admin`;
  `users:manage_own` aktif untuk client_admin HANYA lewat kanal portal; halaman awal: tenant-admin → `/portal`,
  tenant-user tetap `/dashboard` (`landingPath`).
- **SaaS Fase 1 — integrasi** (`feat/saas-p1` = users + billing + tenants): halaman tenant memakai `TenantBillingSummary`
  dan kolom `environments.tenant_check`; form "Tenant baru" + plan Odoo opsional (langganan `implementation` di
  transaksi yang sama); override harga per langganan (`subscriptions.price_amount/price_currency`, disunting di migrasi
  0005 yang belum rilis) dipakai invoice maintenance otomatis (fallback harga plan; keduanya NULL → dilewati + audit);
  email cek tenant-admin hanya saat himpunan tenant tanpa admin berubah (audit tetap harian).
- **SaaS Fase 1 — Subscriptions & Invoices** (ADR 0018 infra, W5/W7): migrasi `0005_saas_p1_billing` (aditif: status
  `implementation|warranty|past_due`, kolom go-live/garansi, `plans.service` + harga nullable, `invoices.kind` + periode +
  referensi bukti, `domains.purpose|dkim_txt|last_check`, `environments.tenant_check`, `notification_log`); seed 7 plan
  D7 saat boot; halaman `/subscriptions` dan `/invoices` (izin `billing:view`, `billing:manage`; tandai lunas
  `invoices:confirm`); `subscription_tick` harian 00:15 WIB (transisi D4, `tenant_suspend`/`tenant_resume` per env
  instance, invoice maintenance, cek tenant-admin, email pengingat via `nodemailer`); `TICK_NOW` hanya staging;
  rekonsiliasi RESULT `state` → `clients.status` dan `mode` → `environments.tenant_check`; halaman publik
  `/suspended[/<slug>]`.
- **SaaS Fase 1 W5 — Tenant/Audit/Realm**: form **"Tenant baru"** (satu transaksi: client + environment + SATU rantai
  onboarding `kc_org_ensure → odoo_db_provision → odoo_route → odoo_sso_provision → odoo_tenant_config(compat) →
  kc_user_ensure → kc_user_set_roles → odoo_user_ensure`), rantai mendukung tipe lama terikat environment
  (`environment_id` server-side, indeks satu-aktif, dedupe), langkah dry-run, `prelude` transaksional; halaman tenant
  (status, `tenant_check`, user, rantai + "Ulangi dari langkah ini", Suspend/Resume override, ringkasan billing); **`/audit`**
  (izin baru `audit:view`); **`/realm`** (`kc_realm_sync` rencana/terapkan + approve prod, daftar user tanpa tenant).
- **SaaS Fase 1 — Users** (kontrak infra `docs/plans/saas-phase-1-contract.md` §2): migrasi `0004_saas_p1_users` (aditif),
  10 tipe job identitas/tenant di `job-contract.ts` (skema Zod `.strict()`, regex = dispatcher 1.1.0, timeout, RESULT keys
  `org roles enabled state tenant`, `idempotency_key`), fixture dispatcher f175457. Rantai job (`after_job_id`/`chain_id`,
  `chain_aborted`), dedupe idempotency, kuota rantai §1.2, allowlist tipe per instance (`INFRA_JOBS_TYPES`).
- Halaman **`/users`** (superadmin/ops): filter tenant termasuk `platform`, tambah user (role CP + akses Odoo per env),
  nonaktifkan/aktifkan, ubah role/akses, reset password, status rantai per langkah. Izin `users:view`, `users:manage`,
  `users:manage_own`, `realm:sync`; otorisasi lintas tenant / satu tenant-admin / tidak mengubah diri sendiri di server.
- Tenant internal `platform` dibuat idempoten oleh `migrate.mjs`; slug `platform` reserved di form.

### Security
- QA ronde 2: N1/N3 rantai realm sync & suspend/resume tidak bisa "Ulangi dari langkah ini"; N2 aktor nonaktif ditolak
  di layanan billing; N4 tanpa invoice/harga nol (Zod + CHECK 0005); N5 portal hanya akses Odoo none|user; N6 kanal
  portal butuh baris DB client_admin aktif; N7 rencana realm tanpa `blockers` = tidak bersih; N8 suspend/resume otomatis
  memakai cek kebalikan aktif + tick melewati tenant terminated; N10 urutan docblock env, filter tanggal /audit = WIB.
- W6: `/users` Server Action = `users:manage` saja (sebelumnya `users:manage | users:manage_own`); layanan Users menolak
  cakupan `own` dari kanal platform dan cakupan `all` dari kanal portal; portal tidak menerima `clientId`/`cp_role` dari
  form; memberi client_admin dari portal ditolak (`role_not_allowed`); `userId` tenant lain → `not_found` (diaudit
  `cross_tenant`). Inventaris statis (uji unit) memastikan setiap halaman/Server Action platform menolak role tenant.
- FK `audit_logs.actor_user_id` / `provision_jobs.actor_user_id` → `ON DELETE RESTRICT` (migrasi 0005; usulan
  `docs/temuan-users-prod-kosong.md`): baris `users` beraudit tidak bisa dihapus.
- Temuan QA Fase 1 (Lead 2026-10-03):
  - **F1 (High)** — pengambilalihan user lama lintas tenant: setiap mutasi Users ditolak bila email sudah ada sebagai
    baris tanpa tenant / ber-role superadmin-ops (untuk tenant klien) / milik tenant lain. Kontrak v1.2: `kc_user_ensure`
    + `adopt` (bool opsional) — hanya superadmin (`enqueueChain` + penjaga worker), diaudit. `users:manage_own` dicabut
    dari client_admin (default-deny sampai portal tenant W6). Rekonsiliasi tidak mengikat baris lama tanpa `adopt`.
  - **F2 (Medium)** — aturan satu tenant-admin ditegakkan atomik saat enqueue (advisory lock per tenant + cek admin
    invited/active dan job `kc_user_set_roles client_admin` aktif).

### Added
- Aksi superadmin **"Ikat ke tenant…"** di `/users` untuk baris lama `client_id IS NULL` (temuan F8): platform (role
  cache tetap) atau tenant klien (tenant-admin/tenant-user) lewat rantai `kc_user_ensure adopt=true → kc_user_set_roles`.

### Fixed
- Temuan "users prod kosong" (`docs/temuan-users-prod-kosong.md`): penyebab = cleanup QA menghapus baris `users` (FK audit
  `ON DELETE SET NULL`) + tidak ada login CP prod sejak itu. Baris `users` kini juga dibuat dari RESULT `kc_user_ensure`;
  nonaktif = `status=disabled`, bukan DELETE.

## [0.8.0] - 2026-10-02

### Added
- **Biaya produksi & margin per SPK** (plan infra 19, hanya untuk hak nilai): panel di detail SPK — nilai SPK tanpa PPN,
  PPN, material (terpakai lewat MO/permintaan barang vs PO barang ber-SPK), jasa/sewa/subkon (tagihan vendor vs PO jasa),
  tenaga kerja dari absensi kiosk/timesheet (+ peringatan jam yang belum bertarif), total biaya, margin Rp & % dan bar
  komposisi. Kolom **Margin** di daftar Dashboard SPK. Sumber kolom baru `mart.mart_spk` (`cost_*`, `margin`,
  `margin_pct`, …) — material & jasa = nilai terbesar antara realisasi dan PO (komitmen PO ikut, tanpa hitung ganda).
- **Status tanda tangan BAST**: badge BAST (belum TTD / TTD n/m / lengkap) di daftar dan header detail SPK, kartu KPI
  "BAST ditandatangani" (+ SPK menunggu TTD), panel BAST di detail SPK (jenis, lokasi, penanda tangan kedua pihak +
  waktu, tautan peta GPS & akurasi bila terekam). Sumber `mart.mart_spk.bast_*` dan `mart.mart_spk_bast`.
- Toleran data mart lama: kolom dibaca lewat `to_jsonb`, tabel BAST dicek `to_regclass` (tidak ada → tanpa panel).

## [0.7.0] - 2026-10-02

### Added
- **Isu link dokumen** (plan infra 18, modul Odoo `custom_doc_trace`): badge "n isu link" di daftar Dashboard SPK dan
  header detail SPK, panel "Isu link dokumen" di detail SPK (aturan dalam bahasa Indonesia, dokumen + tautan ke Odoo,
  status terbuka / diperbaiki otomatis). Sumber `mart.mart_spk.issue_count` dan `mart.mart_spk_issue`; toleran data
  mart lama: kolom dibaca lewat `to_jsonb`, tabel dicek `to_regclass` (tidak ada → tanpa badge/panel).

## [0.6.0] - 2026-10-02

### Changed
- **Tampilan baru dashboard** (Quotation Tracker, Dashboard SPK, detail SPK, indeks `/dashboard`, nav) mengikuti
  referensi website expomedia.id: tema Onyx monokrom terang/gelap (ikut sistem, hanya di `/dashboard`), font Syne +
  Manrope (`next/font`, self-hosted), ikon Iconsax dirender server sebagai SVG (`npm run icons` →
  `src/generated/iconsax-icons.json`; tanpa `dangerouslySetInnerHTML`/atribut `style`), kartu & bento ala 21st.dev,
  angka KPI hitung naik (Motion, satu client component; reduced motion dihormati), animasi masuk & bar tumbuh via
  keyframe CSS. Funnel bergaya stepper ber-ikon, nilai dikelompokkan Penjualan / Penagihan / Supply chain, tab
  Quotation Tracker ↔ Dashboard SPK, stepper Penawaran → Lunas di detail SPK. Data, query, dan hak akses tidak berubah.
- Teks kesegaran data Dashboard SPK: "otomatis ±2 menit" (sebelumnya masih "tiap 30 menit").

### Added
- **Penawaran dibuat vs terkirim**: funnel Quotation Tracker memisah "Penawaran dibuat" (draft) dan "Penawaran
  terkirim" (Odoo `sent`: tombol Send / "Mark Quotation as Sent"; SPK dihitung sudah melewati langkah ini), filter
  tahap `track=terkirim`, badge & stepper Penawaran → Terkirim → SPK di daftar dan detail SPK; Dashboard SPK: filter
  status Penawaran dibuat/terkirim, badge di No SPK, jumlah terkirim di kartu Penawaran. Memakai kolom data mart
  `mart_spk.quotation_state` (infra branch `feat/datamart-quotation-sent`); data mart lama tanpa kolom itu tetap
  jalan (semua penawaran = dibuat, `src/server/mart-spk.ts`).
- **Detail SPK — pengadaan per PO**: satu baris per PO dengan kolom Keterangan (produk, vendor, status terakhir),
  No PO, No GR, Tagihan vendor, Pembayaran ke vendor (nomor & alokasi hanya untuk hak nilai) dan Nilai; MO → surat jalan
  di baris ringkas. Butuh data mart infra `8b16f04` (`mart_spk_scm.po_id`, `mart_spk_vendor_payment`,
  `mart_spk_scm_line`).
- **Halaman detail dokumen** `/dashboard/spk/[soId]/dokumen/[kind]/[docId]` (PO, GR, tagihan vendor, pembayaran ke
  vendor, MO, surat jalan): alur dokumen PO → GR → Tagihan → Pembayaran (atau MO → Surat jalan) dengan tautan, baris
  barang (qty pesan/terima/tagih atau rencana/selesai, hasil & komponen MO). Dokumen wajib milik SPK tsb (akses sama
  dengan detail SPK); pembayaran & nominal hanya untuk hak nilai (tanpa hak → 404).
- Dependensi `motion` 13.4.3 (MIT) dan devDependency `iconsax` 0.1.1 (MIT) — versi sama dengan web-expomedia.

## [0.5.0] - 2026-09-30

### Added
- Quotation Tracker (plan infra 16): langkah **Lead CRM** (`mart.mart_lead`, daftar lead terbaru tanpa penawaran +
  tautan Odoo), **Pengadaan (PO)** dan **Terkirim (surat jalan)** di funnel; kartu nilai pipeline lead, biaya material,
  hutang vendor; kolom "Pengadaan & kirim" (PO, MO, surat jalan).
- Detail SPK: seksi "Pengadaan, produksi & pengiriman" dari `mart.mart_spk_scm` (nominal hanya untuk `canSeeValue`).

### Changed
- Teks kesegaran data: refresh data mart berbasis perubahan (±2 menit), bukan tiap 30 menit.

## [0.4.0] - 2026-09-30

### Added
- **Quotation Tracker** `/dashboard/quotation` (infra plan 15): funnel Penawaran → SPK → Produksi → Absensi kru →
  Ditagih → Lunas dari `mart_spk.tracker_stage` (klik langkah = filter), ringkasan nilai (penawaran terbuka, SPK,
  ditagih, dibayar, piutang, lewat jatuh tempo — hanya untuk hak nilai), tabel per penawaran/SPK dengan tahap,
  produksi, absensi kru, penagihan (jumlah invoice, jatuh tempo terdekat) dan pembayaran. Landing pascalogin Odoo
  bagi grup "Dashboard Quotation Tracker" (`cl_expomedia_web`).
- Detail SPK: bagian **Penagihan** (`mart.mart_spk_invoice`; nominal hanya untuk hak nilai) dan **Pembayaran**
  (`mart.mart_spk_payment`, hanya untuk hak nilai).
- Env opsional `DASHBOARD_ODOO_URLS` (`slug=https://host,…`) untuk tombol "Buka Odoo".

## [0.3.0] - 2026-09-29

### Added
- **Dashboard SPK per client dari data mart** (infra ADR 0016): `/dashboard` menampilkan client yang boleh dilihat
  user (RLS `app.sub` di `mart.mart_user_access`), `/dashboard/spk` (KPI, tahap per SPK, status terakhir, filter/urut,
  halaman) dan `/dashboard/spk/[soId]` (lokasi per task, kegiatan lapangan & kru). Hak lihat **nilai** (nilai SPK,
  tertagih, dibayar, piutang) dari grup Odoo (`sales_team.group_sale_salesman`) — kolom nilai tidak di-SELECT untuk
  user tanpa hak; AE murni hanya melihat SPK miliknya. Pool terpisah `datamart_reader` (max 3), setiap query dalam
  transaksi READ ONLY + `set_config(…, true)`. Bar tanpa style inline (SVG/`<meter>`, CSP tetap ketat).
- Env opsional `DATAMART_URL` + `DATAMART_ENV` (`prod`|`staging`, berpasangan). Kosong = dashboard seperti sebelumnya.

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
