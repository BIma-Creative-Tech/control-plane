/** ADR 0019 #3 — verifikasi HMAC ingest pemakaian tenant. */
import { describe, expect, it } from "vitest";
import { USAGE_MAX_SKEW_SECONDS, signUsage, tenantUsageKey, usagePayloadSchema, verifyUsageRequest } from "@/lib/usage-ingest";

const MASTER = "uji-master-secret-0123456789abcdefghijklmnop";
const NOW = 1_793_500_000;
const body = JSON.stringify({ date: "2026-11-01", seq: 3, users: 1, devices: 1, outlets: 1, trx_month_gross: 120, omzet_month_net: "4500000.00", ai_prompts: 2 });
const sign = (slug: string, ts: string, b = body, master = MASTER) => signUsage(tenantUsageKey(master, slug), ts, b);

describe("verifyUsageRequest", () => {
  it("menerima tanda tangan valid", () => {
    expect(verifyUsageRequest(MASTER, { tenant: "toko-a", ts: String(NOW), sig: sign("toko-a", String(NOW)) }, body, NOW)).toEqual({ ok: true, slug: "toko-a" });
  });

  it("kunci tenant lain tidak berlaku (isolasi per tenant)", () => {
    const sig = sign("toko-b", String(NOW));
    expect(verifyUsageRequest(MASTER, { tenant: "toko-a", ts: String(NOW), sig }, body, NOW)).toEqual({ ok: false, reason: "bad_sig" });
  });

  it("body diubah → ditolak", () => {
    const sig = sign("toko-a", String(NOW));
    expect(verifyUsageRequest(MASTER, { tenant: "toko-a", ts: String(NOW), sig }, body.replace("120", "1"), NOW).ok).toBe(false);
  });

  it("di luar jendela waktu → skew", () => {
    const ts = String(NOW - USAGE_MAX_SKEW_SECONDS - 1);
    expect(verifyUsageRequest(MASTER, { tenant: "toko-a", ts, sig: sign("toko-a", ts) }, body, NOW)).toEqual({ ok: false, reason: "skew" });
  });

  it("header kosong / slug aneh / sig bukan hex", () => {
    expect(verifyUsageRequest(MASTER, { tenant: null, ts: String(NOW), sig: "x" }, body, NOW)).toEqual({ ok: false, reason: "missing_header" });
    expect(verifyUsageRequest(MASTER, { tenant: "../etc", ts: String(NOW), sig: "a".repeat(64) }, body, NOW)).toEqual({ ok: false, reason: "bad_slug" });
    expect(verifyUsageRequest(MASTER, { tenant: "toko-a", ts: String(NOW), sig: "zz" }, body, NOW)).toEqual({ ok: false, reason: "bad_sig" });
  });

  it("body terlalu besar", () => {
    const big = "x".repeat(3000);
    expect(verifyUsageRequest(MASTER, { tenant: "toko-a", ts: String(NOW), sig: sign("toko-a", String(NOW), big) }, big, NOW)).toEqual({ ok: false, reason: "too_large" });
  });
});

describe("usagePayloadSchema", () => {
  it("valid", () => {
    expect(usagePayloadSchema.safeParse(JSON.parse(body)).success).toBe(true);
  });
  it("menolak field asing, negatif, tanggal salah, omzet bukan desimal", () => {
    const base = JSON.parse(body) as Record<string, unknown>;
    expect(usagePayloadSchema.safeParse({ ...base, extra: 1 }).success).toBe(false);
    expect(usagePayloadSchema.safeParse({ ...base, users: -1 }).success).toBe(false);
    expect(usagePayloadSchema.safeParse({ ...base, date: "2026-02-30" }).success).toBe(false);
    expect(usagePayloadSchema.safeParse({ ...base, omzet_month_net: "1e9" }).success).toBe(false);
  });
});
