import { z } from "zod";

/** Validasi searchParams daftar client (server side). Nilai tak valid → default aman. */
const schema = z.object({
  q: z
    .string()
    .regex(/^[a-z0-9-]{1,30}$/)
    .optional()
    .catch(undefined),
  page: z.coerce.number().int().min(1).max(1000).default(1).catch(1),
});

export type ClientListParams = z.infer<typeof schema>;

export function parseClientListParams(raw: Record<string, string | string[] | undefined>): ClientListParams {
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  return schema.parse({ q: first(raw.q) || undefined, page: first(raw.page) });
}
