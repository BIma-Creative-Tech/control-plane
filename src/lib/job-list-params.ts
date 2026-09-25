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
  precondition: "Prasyarat belum terpenuhi (mis. route belum aktif, user belum terdaftar, job tidak bisa diulang).",
  quota: "Kuota job tercapai — coba lagi nanti.",
  duplicate: "Masih ada job aktif dengan tipe yang sama untuk environment ini.",
  error: "Gagal memproses permintaan. Lihat log server.",
  confirm: "Konfirmasi slug tidak cocok.",
  origin: "Permintaan ditolak (Origin tidak valid).",
  disabled: "Jembatan job belum dikonfigurasi di instance ini (INFRA_JOBS_INSTANCE).",
  not_found: "Data tidak ditemukan.",
  created: "Tersimpan.",
  exists: "Sudah ada (slug/environment/DB duplikat).",
};
