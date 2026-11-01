/**
 * BCTOne AI gateway (K-xx consent dua jalur, BR-05/06/07/11) — modul MURNI.
 *
 * - Consent wajib dipilih eksplisit (null = belum memilih → AI ditolak). `allow` → Claude via 9router; `deny` → Ollama
 *   VPS via 9router (key terpisah yang di 9router dibatasi ke `ollama-local/*`). Jalur `deny` TIDAK PERNAH fallback.
 * - Log consent append-only hash-chain: hash = sha256(prev_hash | client_id | consent | actor | created_at ISO).
 * - PII dimasking sebelum prompt keluar dari CP (email, nomor telepon ID, NIK/angka panjang).
 */
import { createHash } from "node:crypto";
import { z } from "zod";

export const AI_CONSENTS = ["allow", "deny"] as const;
export type AiConsent = (typeof AI_CONSENTS)[number];

export const AI_DEFAULT_MODELS: Record<AiConsent, string> = {
  allow: "cc/claude-haiku-4-5-20251001",
  deny: "ollama-local/qwen2.5:3b",
};
/** BR: jalur tolak hanya boleh model lokal — dicek lagi di sini walau key 9router sudah dibatasi. */
export function modelAllowedFor(consent: AiConsent, model: string): boolean {
  return consent === "deny" ? model.startsWith("ollama-local/") : model.startsWith("cc/");
}

export const AI_TIMEOUT_MS: Record<AiConsent, number> = { allow: 60_000, deny: 15_000 };
export const AI_MAX_BODY_BYTES = 16_384;

export const aiRequestSchema = z
  .object({
    request_id: z.string().uuid(),
    /** Fitur pemanggil (whitelist) — untuk audit/kuota per fitur nanti. */
    feature: z.enum(["assistant", "product_desc", "report_summary", "provisioning"]),
    messages: z
      .array(z.object({ role: z.enum(["system", "user", "assistant"]), content: z.string().min(1).max(6000) }).strict())
      .min(1)
      .max(12),
    max_tokens: z.number().int().min(16).max(1024).default(512),
  })
  .strict();
export type AiRequest = z.infer<typeof aiRequestSchema>;

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE_RE = /(?:\+62[ .-]?|62|0)8[0-9][0-9 .-]{6,13}[0-9]/g;
const LONG_NUM_RE = /\b[0-9]{12,20}\b/g;

export function maskPii(text: string): string {
  return text.replace(EMAIL_RE, "[email]").replace(PHONE_RE, "[telepon]").replace(LONG_NUM_RE, "[nomor]");
}

export function consentHash(prevHash: string | null, clientId: string, consent: AiConsent, actor: string, createdAt: Date): string {
  return createHash("sha256")
    .update([prevHash ?? "GENESIS", clientId, consent, actor, createdAt.toISOString()].join("|"), "utf8")
    .digest("hex");
}

/** Verifikasi rantai (urut id naik). Return indeks baris pertama yang rusak, atau -1 bila utuh. */
export function verifyConsentChain(
  rows: { clientId: string; consent: AiConsent; actor: string; createdAt: Date; prevHash: string | null; hash: string }[],
): number {
  let prev: string | null = null;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    if (r.prevHash !== prev || consentHash(prev, r.clientId, r.consent, r.actor, r.createdAt) !== r.hash) return i;
    prev = r.hash;
  }
  return -1;
}
