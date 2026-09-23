import { z } from "zod";
import { slugSchema } from "../lib/slug";

/**
 * Registry job worker. Pola: setiap job punya skema Zod `.strict()` untuk argumen
 * (whitelist — field tak dikenal ditolak), lalu handler hanya menerima data tervalidasi.
 * Scaffold: hanya `noop`. BELUM memanggil skrip host / docker-socket-proxy.
 */
export const QUEUE_NOOP = "noop";

export const noopPayloadSchema = z
  .object({
    slug: slugSchema,
    provisionJobId: z.uuid().optional(),
  })
  .strict();

export type NoopPayload = z.infer<typeof noopPayloadSchema>;

export interface JobResult {
  ok: true;
  slug: string;
}

/** Validasi argumen; lempar error generik tanpa menggemakan input. */
export function parseNoopPayload(data: unknown): NoopPayload {
  const parsed = noopPayloadSchema.safeParse(data);
  if (!parsed.success) {
    throw new Error("argumen job noop ditolak whitelist");
  }
  return parsed.data;
}

export async function handleNoop(payload: NoopPayload): Promise<JobResult> {
  return { ok: true, slug: payload.slug };
}
