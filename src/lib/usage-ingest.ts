/**
 * ADR 0019 #3 — ingest pemakaian harian tenant BCTOne (addon Odoo `bct_tenant_agent` → control-plane). Modul MURNI.
 *
 * Autentikasi: HMAC-SHA256 per tenant. Kunci tenant = HMAC(USAGE_INGEST_SECRET, "bctone-usage:" + slug) — tenant hanya
 * memegang kuncinya sendiri (diturunkan & dipasang saat provisioning), master tidak pernah keluar dari CP.
 * Header: `X-BCT-Tenant: <slug>`, `X-BCT-Ts: <unix detik>`, `X-BCT-Sig: <hex>` dengan
 *   sig = HMAC(kunci_tenant, `${ts}.${rawBody}`), jendela waktu ±300 detik.
 * Replay: `seq` monoton per (tenant, tanggal) — kiriman dengan seq ≤ yang tersimpan tidak mengubah data.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { isIsoDate } from "./billing";

export const USAGE_MAX_SKEW_SECONDS = 300;
export const USAGE_MAX_BODY_BYTES = 2048;
const SLUG_RE = /^[a-z0-9-]{3,30}$/;

export function tenantUsageKey(masterSecret: string, slug: string): Buffer {
  return createHmac("sha256", masterSecret).update(`bctone-usage:${slug}`, "utf8").digest();
}

export function signUsage(key: Buffer, ts: string, rawBody: string): string {
  return createHmac("sha256", key).update(`${ts}.${rawBody}`, "utf8").digest("hex");
}

export type VerifyFailure = "missing_header" | "bad_slug" | "bad_ts" | "skew" | "too_large" | "bad_sig";

export function verifyUsageRequest(
  masterSecret: string,
  h: { tenant: string | null; ts: string | null; sig: string | null },
  rawBody: string,
  nowSeconds: number,
): { ok: true; slug: string } | { ok: false; reason: VerifyFailure } {
  if (!h.tenant || !h.ts || !h.sig) return { ok: false, reason: "missing_header" };
  if (!SLUG_RE.test(h.tenant)) return { ok: false, reason: "bad_slug" };
  if (!/^[0-9]{9,11}$/.test(h.ts)) return { ok: false, reason: "bad_ts" };
  if (Math.abs(nowSeconds - Number(h.ts)) > USAGE_MAX_SKEW_SECONDS) return { ok: false, reason: "skew" };
  if (Buffer.byteLength(rawBody, "utf8") > USAGE_MAX_BODY_BYTES) return { ok: false, reason: "too_large" };
  if (!/^[0-9a-f]{64}$/.test(h.sig)) return { ok: false, reason: "bad_sig" };
  const expected = Buffer.from(signUsage(tenantUsageKey(masterSecret, h.tenant), h.ts, rawBody), "hex");
  const got = Buffer.from(h.sig, "hex");
  if (!timingSafeEqual(expected, got)) return { ok: false, reason: "bad_sig" };
  return { ok: true, slug: h.tenant };
}

const nonNegInt = z.number().int().min(0).max(2_000_000_000);

export const usagePayloadSchema = z
  .object({
    date: z.string().refine(isIsoDate, "tanggal YYYY-MM-DD"),
    seq: nonNegInt,
    users: nonNegInt,
    devices: nonNegInt,
    outlets: nonNegInt,
    trx_month_gross: nonNegInt,
    /** Omzet bulan berjalan tanpa pajak, string desimal ≤ 14 digit + 2 desimal. */
    omzet_month_net: z.string().regex(/^(0|[1-9][0-9]{0,13})(\.[0-9]{1,2})?$/),
    ai_prompts: nonNegInt.default(0),
  })
  .strict();

export type UsagePayload = z.infer<typeof usagePayloadSchema>;
