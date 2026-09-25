/**
 * Ekstrak kode error Postgres (SQLSTATE) + nama constraint dari error pg / DrizzleQueryError (`cause`).
 * JANGAN log `err.message` DrizzleQueryError: memuat parameter query (bisa berisi email/PII).
 */
export function pgErrorInfo(err: unknown): { code?: string; constraint?: string } {
  let cur: unknown = err;
  for (let i = 0; i < 4 && cur && typeof cur === "object"; i++) {
    const e = cur as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (typeof e.code === "string" && /^[0-9A-Z]{5}$/.test(e.code)) {
      return { code: e.code, constraint: typeof e.constraint === "string" ? e.constraint : undefined };
    }
    cur = e.cause;
  }
  return {};
}

export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const info = pgErrorInfo(err);
  return info.code === "23505" && (constraint === undefined || info.constraint === constraint);
}

/** Pesan aman untuk log (tanpa query/params). */
export function safeErrorMessage(err: unknown): string {
  const info = pgErrorInfo(err);
  if (info.code) return `pg ${info.code}${info.constraint ? ` (${info.constraint})` : ""}`;
  if (err instanceof Error && err.name !== "DrizzleQueryError") return err.message.slice(0, 300);
  return "error";
}
