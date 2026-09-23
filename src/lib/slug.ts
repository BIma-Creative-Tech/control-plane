import { z } from "zod";

/**
 * Whitelist argumen untuk job orkestrasi (nextjs-developer.md §Orkestrasi).
 * Semua argumen yang kelak diteruskan ke skrip host HARUS lolos skema ini.
 */
export const SLUG_REGEX = /^[a-z0-9-]{3,30}$/;

export const slugSchema = z.string().regex(SLUG_REGEX, "slug tidak valid");

export function isValidSlug(value: unknown): value is string {
  return typeof value === "string" && SLUG_REGEX.test(value);
}
