import { describe, expect, it } from "vitest";
import { AI_DEFAULT_MODELS, aiRequestSchema, consentHash, maskPii, modelAllowedFor, verifyConsentChain, type AiConsent } from "@/lib/ai-gateway";
import { signUsage, tenantKey, tenantUsageKey, verifyTenantRequest, verifyUsageRequest } from "@/lib/usage-ingest";

const M = "m".repeat(40);

describe("consent dua jalur", () => {
  it("jalur tolak hanya ollama-local, izinkan hanya cc/", () => {
    expect(AI_DEFAULT_MODELS.deny).toBe("ollama-local/qwen2.5:3b");
    expect(modelAllowedFor("deny", AI_DEFAULT_MODELS.deny)).toBe(true);
    expect(modelAllowedFor("deny", "cc/claude-haiku-4-5-20251001")).toBe(false);
    expect(modelAllowedFor("allow", AI_DEFAULT_MODELS.allow)).toBe(true);
    expect(modelAllowedFor("allow", "ollama-local/qwen2.5:3b")).toBe(false);
  });
});

describe("masking PII", () => {
  it("email, telepon ID, NIK", () => {
    const s = maskPii("hubungi budi@toko.co.id / +62 812-3456-7890 / 08123456789, NIK 3173012345678901 harga 25000");
    expect(s).toBe("hubungi [email] / [telepon] / [telepon], NIK [nomor] harga 25000");
  });
});

describe("hash-chain consent", () => {
  const t = (s: number) => new Date(Date.UTC(2026, 10, 1, 0, 0, s));
  const rows: { clientId: string; consent: AiConsent; actor: string; createdAt: Date; prevHash: string | null; hash: string }[] = [];
  let prev: string | null = null;
  for (const [i, c] of (["allow", "deny", "allow"] as AiConsent[]).entries()) {
    const h = consentHash(prev, "c1", c, "user:x", t(i));
    rows.push({ clientId: "c1", consent: c, actor: "user:x", createdAt: t(i), prevHash: prev, hash: h });
    prev = h;
  }
  it("utuh", () => expect(verifyConsentChain(rows)).toBe(-1));
  it("ubah isi baris tengah terdeteksi", () => {
    expect(verifyConsentChain(rows.map((r, i) => (i === 1 ? { ...r, consent: "allow" as const } : r)))).toBe(1);
  });
  it("hapus baris terdeteksi", () => expect(verifyConsentChain([rows[0]!, rows[2]!])).toBe(1));
});

describe("kunci per domain", () => {
  it("kunci usage lama tidak berubah; kunci AI berbeda; sig usage ditolak di AI", () => {
    expect(tenantUsageKey(M, "toko-a").equals(tenantKey(M, "bctone-usage", "toko-a"))).toBe(true);
    expect(tenantKey(M, "bctone-ai", "toko-a").equals(tenantUsageKey(M, "toko-a"))).toBe(false);
    const ts = "1793500000";
    const body = "{}";
    const sigUsage = signUsage(tenantUsageKey(M, "toko-a"), ts, body);
    const h = { tenant: "toko-a", ts, sig: sigUsage };
    expect(verifyUsageRequest(M, h, body, 1793500000).ok).toBe(true);
    expect(verifyTenantRequest(M, "bctone-ai", h, body, 1793500000, 16384)).toEqual({ ok: false, reason: "bad_sig" });
    const sigAi = signUsage(tenantKey(M, "bctone-ai", "toko-a"), ts, body);
    expect(verifyTenantRequest(M, "bctone-ai", { ...h, sig: sigAi }, body, 1793500000, 16384).ok).toBe(true);
  });
});

describe("request schema", () => {
  it("strict; batas pesan", () => {
    const ok = { request_id: "3f2c7a9e-1b4d-4e8a-9c3f-5a6b7c8d9e0f", feature: "assistant", messages: [{ role: "user", content: "hai" }] };
    expect(aiRequestSchema.parse(ok).max_tokens).toBe(512);
    expect(aiRequestSchema.safeParse({ ...ok, model: "cc/claude-opus-5" }).success).toBe(false);
    expect(aiRequestSchema.safeParse({ ...ok, feature: "x" }).success).toBe(false);
    expect(aiRequestSchema.safeParse({ ...ok, messages: Array(13).fill(ok.messages[0]) }).success).toBe(false);
  });
});
