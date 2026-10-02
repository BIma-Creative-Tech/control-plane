import { z } from "zod";
import { BRIDGE_JOB_TYPES } from "./job-contract";
import { SLUG_REGEX } from "./slug";

export const JOB_STATUSES = ["queued", "dispatched", "running", "succeeded", "failed", "cancelled"] as const;
export const ALL_JOB_TYPES = ["noop", "provision", "suspend", "resume", "terminate", "backup_now", "restore", ...BRIDGE_JOB_TYPES] as const;

/** searchParams halaman /jobs — nilai tak valid → diabaikan (default aman). */
const schema = z.object({
  client: z.string().regex(SLUG_REGEX).optional().catch(undefined),
  status: z.enum(JOB_STATUSES).optional().catch(undefined),
  type: z.enum(ALL_JOB_TYPES).optional().catch(undefined),
  page: z.coerce.number().int().min(1).max(1000).default(1).catch(1),
});

export type JobListParams = z.infer<typeof schema>;

export function parseJobListParams(raw: Record<string, string | string[] | undefined>): JobListParams {
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  return schema.parse({
    client: first(raw.client) || undefined,
    status: first(raw.status) || undefined,
    type: first(raw.type) || undefined,
    page: first(raw.page),
  });
}

/** Kode umpan balik aksi (query `?r=`) — whitelist, tidak pernah memantulkan input user. */
export const ACTION_RESULT_CODES = [
  "queued",
  "forbidden",
  "invalid",
  "precondition",
  "quota",
  "duplicate",
  "error",
  "confirm",
  "origin",
  "disabled",
  "not_found",
  "created",
  "exists",
  "reauth",
  // Halaman Users (kontrak Fase 1 §2.3)
  "cross_tenant",
  "role_not_allowed",
  "self_action",
  "one_admin",
  "name_invalid",
  "email_other_tenant",
  "tenant_inactive",
  "user_disabled",
  // Temuan QA F1 (pengikatan email / adopt user lama)
  "email_unbound",
  "email_platform_role",
  "already_bound",
  // Subscriptions & Invoices (ADR 0018)
  "billing_status",
  "service_exists",
  "invoice_state",
  "future_date",
  "plan_inactive",
  // Tenant (Fase 1 W5): onboarding, suspend/resume, sync realm
  "slug_reserved",
  "host_invalid",
  "host_taken",
  "state_busy",
  "no_env",
  "plan_required",
  "approve_required",
  // Portal tenant (W6)
  "plan_limit",
  // Domains (W5)
  "updated",
  "deleted",
  "env_mismatch",
] as const;
export type ActionResultCode = (typeof ACTION_RESULT_CODES)[number];

export function parseActionResult(raw: string | string[] | undefined): ActionResultCode | null {
  const v = Array.isArray(raw) ? raw[0] : raw;
  const p = z.enum(ACTION_RESULT_CODES).safeParse(v);
  return p.success ? p.data : null;
}

export const ACTION_RESULT_TEXT: Record<ActionResultCode, string> = {
  queued: "Job masuk antrean.",
  forbidden: "Akses ditolak untuk aksi ini.",
  invalid: "Input ditolak validasi.",
  precondition:
    "Prasyarat belum terpenuhi (mis. route belum aktif, user belum terdaftar, kirim ulang undangan hanya untuk user berstatus active, job tidak bisa diulang).",
  quota: "Kuota job tercapai — coba lagi nanti.",
  duplicate: "Masih ada job aktif dengan tipe yang sama untuk environment ini.",
  error: "Gagal memproses permintaan. Lihat log server.",
  confirm: "Konfirmasi slug tidak cocok.",
  origin: "Permintaan ditolak (Origin tidak valid).",
  disabled: "Jembatan job belum dikonfigurasi di instance ini (INFRA_JOBS_INSTANCE).",
  not_found: "Data tidak ditemukan.",
  created: "Tersimpan.",
  exists: "Sudah ada (slug/environment/DB duplikat).",
  reauth: "Sesi dibuat sebelum pembaruan identitas — silakan logout lalu login ulang untuk menjalankan aksi.",
  cross_tenant: "Ditolak: user atau tenant di luar cakupan akun Anda.",
  role_not_allowed:
    "Role tidak diizinkan: platform-admin/platform-viewer hanya untuk tenant platform, tenant-admin/tenant-user hanya untuk tenant klien.",
  self_action: "Tidak bisa menonaktifkan atau mengubah role akun sendiri.",
  one_admin: "Tenant sudah punya satu tenant-admin aktif/diundang (maksimal satu per tenant).",
  name_invalid:
    "Nama hanya boleh huruf/angka ASCII, spasi, titik, koma, apostrof, dan tanda hubung (maks. 100 karakter; huruf beraksen belum didukung).",
  email_other_tenant: "Email sudah terdaftar pada tenant lain.",
  tenant_inactive: "Tenant sudah diterminasi.",
  user_disabled: "User nonaktif — aktifkan dulu.",
  email_unbound:
    "Email sudah ada sebagai user lama tanpa tenant — ikat dulu lewat aksi \"Ikat ke tenant…\" (khusus platform-admin).",
  email_platform_role: "Email milik user platform (platform-admin/platform-viewer) — tidak bisa dipakai di tenant klien.",
  already_bound: "User sudah terikat ke tenant.",
  billing_status: "Status langganan tidak mengizinkan aksi ini (lihat tabel transisi ADR 0018 D4).",
  service_exists: "Tenant sudah punya langganan aktif untuk layanan yang sama.",
  invoice_state: "Status invoice tidak mengizinkan aksi ini (hanya invoice belum lunas yang bisa di-void/ditandai lunas).",
  future_date: "Tanggal tidak boleh di masa depan.",
  plan_inactive: "Plan tidak aktif atau belum punya layanan.",
  slug_reserved: "Slug `platform` dicadangkan untuk tenant internal.",
  host_invalid:
    "Host tidak valid: prod/demo harus <label>.erp.bimacreative.tech, staging <label>.staging.bimacreative.tech; demo wajib host dan berbeda dari prod.",
  host_taken: "Host sudah dipakai environment lain.",
  state_busy: "Masih ada job suspend/resume kebalikannya yang aktif untuk tenant ini — tunggu selesai.",
  no_env: "Tenant tidak punya environment yang dilayani instance ini.",
  plan_required: "Jalankan \"Rencana sync realm\" dulu: rencana terakhir harus sukses (≤ 24 jam) tanpa blocker.",
  approve_required: "Realm prod/demo: centang persetujuan eksplisit sebelum menerapkan.",
  plan_limit: "Batas jumlah user paket langganan tercapai (user aktif + undangan + yang sedang diproses). Hubungi admin platform untuk menaikkan paket.",
  updated: "Perubahan tersimpan.",
  deleted: "Data dihapus.",
  env_mismatch:
    "Environment tidak cocok: hanya domain odoo/web yang boleh ditautkan, dan environment harus milik tenant yang sama.",
};
