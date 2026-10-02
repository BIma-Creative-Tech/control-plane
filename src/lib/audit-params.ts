/**
 * Filter halaman /audit (W5) — modul murni (diuji unit). Nilai tak valid → diabaikan (default aman), tidak pernah
 * dipantulkan mentah. Prefix aktor/aksi dibandingkan dengan `starts_with()` (bukan LIKE → tanpa wildcard).
 */
import { z } from "zod";
import { SLUG_REGEX } from "./slug";

/** Asia/Jakarta = UTC+7 (tanpa DST). */
const WIB_OFFSET_MS = 7 * 3600_000;

export const AUDIT_PAGE_SIZE = 50;
export const AUDIT_RESULTS = ["success", "rejected", "failure"] as const;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Sub Keycloak (UUID/alfanumerik) atau label aktor lengkap `user:…` / `system:…`. */
const ACTOR_RE = /^(?:(?:user|system):)?[A-Za-z0-9._@-]{1,128}$/;
const ACTION_RE = /^[a-z0-9_.-]{1,64}$/;

function validDate(v: string): boolean {
  if (!DATE_RE.test(v)) return false;
  const t = Date.parse(`${v}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === v;
}

const schema = z.object({
  actor: z.string().trim().regex(ACTOR_RE).optional().catch(undefined),
  tenant: z.string().regex(SLUG_REGEX).optional().catch(undefined),
  action: z.string().trim().regex(ACTION_RE).optional().catch(undefined),
  result: z.enum(AUDIT_RESULTS).optional().catch(undefined),
  from: z.string().refine(validDate).optional().catch(undefined),
  to: z.string().refine(validDate).optional().catch(undefined),
  page: z.coerce.number().int().min(1).max(10_000).default(1).catch(1),
});

export interface AuditParams {
  /** Prefix kolom audit_logs.actor (sub tanpa awalan → `user:<sub>`). */
  actorPrefix?: string;
  tenant?: string;
  actionPrefix?: string;
  result?: (typeof AUDIT_RESULTS)[number];
  /** Inklusif, 00:00 UTC. */
  from?: Date;
  /** Eksklusif: hari berikutnya 00:00 UTC (tanggal `to` inklusif). */
  toExclusive?: Date;
  page: number;
  /** Nilai mentah tervalidasi untuk mengisi ulang form/pager. */
  raw: Record<string, string>;
}

export function parseAuditParams(sp: Record<string, string | string[] | undefined>): AuditParams {
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const d = schema.parse({
    actor: first(sp.actor) || undefined,
    tenant: first(sp.tenant) || undefined,
    action: first(sp.action) || undefined,
    result: first(sp.result) || undefined,
    from: first(sp.from) || undefined,
    to: first(sp.to) || undefined,
    page: first(sp.page),
  });
  const out: AuditParams = { page: d.page, raw: {} };
  if (d.actor) {
    out.actorPrefix = /^(user|system):/.test(d.actor) ? d.actor : `user:${d.actor}`;
    out.raw.actor = d.actor;
  }
  if (d.tenant) out.tenant = out.raw.tenant = d.tenant;
  if (d.action) out.actionPrefix = out.raw.action = d.action;
  if (d.result) {
    out.result = d.result;
    out.raw.result = d.result;
  }
  let from = d.from ? new Date(`${d.from}T00:00:00Z`) : undefined;
  let to = d.to ? new Date(Date.parse(`${d.to}T00:00:00Z`) + 86_400_000) : undefined;
  // Rentang terbalik → ditukar (bukan hasil kosong yang membingungkan).
  if (from && to && from.getTime() >= to.getTime()) {
    const f = new Date(to.getTime() - 86_400_000);
    to = new Date(from.getTime() + 86_400_000);
    from = f;
  }
  // QA N10: tanggal filter = hari kalender Asia/Jakarta (WIB, UTC+7 tanpa DST) → batas UTC = 00:00 WIB = 17:00 UTC sehari
  // sebelumnya. Nilai `raw` tetap tanggal yang dipilih.
  if (from) {
    out.from = new Date(from.getTime() - WIB_OFFSET_MS);
    out.raw.from = from.toISOString().slice(0, 10);
  }
  if (to) {
    out.toExclusive = new Date(to.getTime() - WIB_OFFSET_MS);
    out.raw.to = new Date(to.getTime() - 86_400_000).toISOString().slice(0, 10);
  }
  return out;
}

/** Query string untuk pager (filter yang sama, halaman lain). */
export function auditPageHref(p: AuditParams, page: number): string {
  const q = new URLSearchParams({ ...p.raw, page: String(page) });
  return `/audit?${q.toString()}`;
}

const EMAIL_LIKE = /[^\s"'<>@]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,63}/g;

/**
 * Metadata audit untuk TAMPILAN: email tidak pernah ditampilkan (audit sudah menyimpan `email_hash`; baris lama /
 * kunci tak terduga yang memuat email disamarkan `[email]`). Kunci `email`/`emails` dibuang seluruhnya.
 */
export function redactAuditMetadata(md: unknown, depth = 0): unknown {
  if (depth > 6) return "[…]";
  if (typeof md === "string") return md.replace(EMAIL_LIKE, "[email]");
  if (Array.isArray(md)) return md.slice(0, 50).map((v) => redactAuditMetadata(v, depth + 1));
  if (md && typeof md === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(md as Record<string, unknown>)) {
      if (/^(email|emails|login|admin_email)$/i.test(k)) {
        out[k] = "[email]";
        continue;
      }
      out[k] = redactAuditMetadata(v, depth + 1);
    }
    return out;
  }
  return md;
}
