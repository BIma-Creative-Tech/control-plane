# Temuan: tabel `users` prod kosong, `audit_logs.actor_user_id` NULL

Status: **TERJAWAB** (SaaS Fase 1 W3, syarat owner #2 / ADR 0018 Consequences). Diperiksa 2026-10-02/03 secara read-only
(FREEZE DEMO): `SELECT` agregat di `control_plane` / `control_plane_staging` (tanpa isi PII), `pg_stat_user_tables`,
`information_schema.role_table_grants`, riwayat git `control-plane` + `infra`, log akses Traefik (hitungan per host/hari,
tanpa IP), dokumen QA. Tidak ada perubahan pada DB/container.

## Fakta

| | prod (`control_plane`) | staging (`control_plane_staging`) |
|---|---|---|
| `users` | **0** baris | 4 baris (dibuat 2026-09-29 04:05–04:58Z, login terakhir 2026-10-02) |
| `audit_logs` | 19 (2026-09-25 09:37Z … 2026-09-26 09:25Z), **19/19 `actor_user_id` NULL** | 77 (semua 2026-09-25), 77/77 NULL |
| `provision_jobs` | 8, 8/8 `actor_user_id` NULL | 32, 32/32 NULL |
| prefiks aktor audit | `user` 11 baris (2 aktor berbeda, sub 36 karakter), `system` 8 (`job.finish`) | `user` 45, `system` 32 |
| `pg_stat_user_tables` `users` | `n_tup_ins=2`, `n_tup_upd=1`, **`n_tup_del=2`** | `n_tup_ins=13`, **`n_tup_del=9`**, live 4 |
| `pg_stat_user_tables` `audit_logs` | `n_tup_upd=11` (= jumlah baris aktor `user`) | `n_tup_upd=20` |
| hak role aplikasi atas `users` | `control_plane`: SELECT/INSERT/UPDATE/DELETE/… (pemilik) | `control_plane_staging`: identik |
| callback OIDC CP (`/api/auth/callback/keycloak`, 302) | 09-23 ×1, 09-25 ×1, 09-26 ×2, **tidak ada sejak 2026-09-26** | 09-25 ×12, 09-26, 09-29 ×8, 09-30 ×6, 10-02 ×2 |

Image prod (`web/control-plane/docker-compose.yml` infra): `4fc3828` (2026-09-23, belum ada upsert `users`) →
**`6d94d2b` sejak 2026-09-25 13:58 WIB (06:58Z)** (upsert saat login + perbaikan BUG-J5-02 `ensureUserId` di setiap aksi)
→ `c4c1051` … `3d4aa7c`. Semua aktivitas audit prod (09:37Z 09-25 dst.) terjadi pada kode yang sudah mengisi `users`.

## Penyebab (terbukti)

1. **Baris `users` prod dibuat lalu DIHAPUS oleh cleanup QA**, bukan gagal dibuat:
   - `infra/docs/qa/2026-09-25-plan05-prod-backfill.md` §Cleanup: "Baris `users` CP sementara dihapus (prod 1, staging 1)";
     P5/P7 di dokumen yang sama mencatat `actor_user_id` **terisi** saat uji.
   - `infra/docs/qa/2026-09-26-plan06-prod.md` §Cleanup: "baris `users` CP sementara dihapus (prod 1, staging 1)".
   - Cocok persis dengan `n_tup_ins=2`, `n_tup_del=2` dan 2 aktor `user:` berbeda di audit prod. Staging: QA J5 menghapus
     4 + 2 baris `qa05*`, backfill 1, plan 06 1 (`n_tup_del=9`).
2. **`actor_user_id` NULL = efek FK `ON DELETE SET NULL`** (`audit_logs.actor_user_id`, `provision_jobs.actor_user_id` →
   `users.id`, migrasi 0000). `audit_logs.n_tup_upd=11` di prod = tepat 11 baris audit beraktor `user` yang di-NULL-kan oleh
   DELETE tersebut (audit tidak pernah di-UPDATE oleh kode).
3. **Tidak ada login CP prod dengan akun nyata sejak 2026-09-26** (log akses Traefik: 0 callback OIDC `cp.bimacreative.tech`
   sejak cleanup plan 06), sehingga tidak ada baris baru. Login nyata di staging (09-29 …) membuat baris dengan benar → jalur
   upsert berfungsi.
4. **Bukan** masalah hak DB (grant prod = staging, keduanya pemilik tabel; tidak ada RLS/trigger di `users`), **bukan**
   kegagalan upsert diam-diam (staging berhasil dengan kode yang sama; log prod 2026-10-02 tanpa warn
   "upsert users saat login gagal" — catatan: log container sebelum recreate 2026-10-02 10:39Z tidak tersedia).

Konsekuensi: atribusi 19 baris audit prod tetap ada di kolom teks `actor` (`user:<sub Keycloak>`); sub tersebut milik akun QA
yang sudah dihapus dari Keycloak (dicatat di dokumen QA), jadi `actor_user_id` tidak bisa dipulihkan.

## Perbaikan

Kode/skema (branch `feat/saas-p1-users`):

1. **`users` tidak lagi hanya lahir dari login**: job `kc_user_ensure` (rantai Tambah user di `/users`) meng-upsert baris
   `users` dari RESULT `kc_user` (= `sub`) dengan `client_id` tenant, `status=invited`, `invited_by`
   (`src/jobs/user-reconcile.ts`); login pertama mengubah `invited → active` (`src/db/users.ts`).
2. **Menonaktifkan user = `status=disabled` (+ `disabled_at`)**, kolom baru migrasi 0004 — tidak ada alasan lagi untuk
   `DELETE FROM users`. **Aturan QA/ops baru: baris `users` CP tidak pernah dihapus** (cleanup uji: nonaktifkan lewat
   `/users` atau `UPDATE users SET status='disabled', disabled_at=now()`), agar `actor_user_id` audit tetap utuh.
3. Tidak ada SQL grant yang dibutuhkan untuk prod.

Usulan untuk Lead (BUKAN bagian 0004 — kontrak §2.1 tidak memuatnya): migrasi berikutnya mengganti FK
`audit_logs.actor_user_id` / `provision_jobs.actor_user_id` dari `ON DELETE SET NULL` → `ON DELETE RESTRICT`, sehingga
DELETE `users` yang punya jejak audit ditolak DB:

```sql
ALTER TABLE audit_logs DROP CONSTRAINT audit_logs_actor_user_id_users_id_fk,
  ADD CONSTRAINT audit_logs_actor_user_id_users_id_fk FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE RESTRICT;
ALTER TABLE provision_jobs DROP CONSTRAINT provision_jobs_actor_user_id_users_id_fk,
  ADD CONSTRAINT provision_jobs_actor_user_id_users_id_fk FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE RESTRICT;
```

SQL perbaikan data (opsional, **jangan dijalankan saat freeze**; aman/idempoten): menautkan ulang `actor_user_id` dari kolom
`actor` bila baris `users` untuk sub itu ada. Untuk prod hari ini hasilnya **0 baris** (akun QA sudah dihapus) — berguna
setelah login nyata/impor user:

```sql
UPDATE audit_logs a SET actor_user_id = u.id FROM users u
 WHERE a.actor_user_id IS NULL AND a.actor = 'user:' || u.keycloak_sub;
UPDATE provision_jobs j SET actor_user_id = u.id FROM users u
 WHERE j.actor_user_id IS NULL AND j.actor = 'user:' || u.keycloak_sub;
```

## Verifikasi setelah deploy (staging dulu, lalu prod di jendela M4)

1. `SELECT count(*), max(last_login_at) FROM users;` sebelum dan sesudah satu login akun superadmin nyata → bertambah 1 /
   `last_login_at` terisi.
2. Satu aksi mutasi (mis. `/users` reset password di staging) → `audit_logs.actor_user_id IS NOT NULL` untuk baris itu.
3. Tambah user di staging → setelah `kc_user_ensure` sukses: baris `users` `status=invited`, `client_id` tenant, `invited_by`
   terisi; setelah login pertama user itu → `active`.
