import { z } from "zod";

/**
 * Whitelist argumen untuk job orkestrasi (nextjs-developer.md §Orkestrasi).
 * Semua argumen yang kelak diteruskan ke skrip host HARUS lolos skema ini.
 */
/**
 * = SLUG_RE dispatcher `scripts/infra-job/infra_job.py` (infra 1bcfe0a): 3–30 karakter, tidak diawali/diakhiri
 * '-' — lebih ketat dari skrip (`^[a-z0-9-]{3,30}$`) dan CHECK DB `clients_slug_format` (tidak diubah: additive).
 */
export const SLUG_REGEX = /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/;

export const slugSchema = z.string().regex(SLUG_REGEX, "slug tidak valid");

export function isValidSlug(value: unknown): value is string {
  return typeof value === "string" && SLUG_REGEX.test(value);
}
