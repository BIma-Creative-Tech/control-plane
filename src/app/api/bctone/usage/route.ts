/**
 * POST /api/bctone/usage — ADR 0019 #3. Dinonaktifkan (404) bila USAGE_INGEST_SECRET tidak di-set (kill switch, default
 * mati). Tanpa sesi/cookie: hanya HMAC per tenant (lib/usage-ingest.ts). Respons tidak membedakan alasan tolak.
 */
import { getDb } from "@/db";
import { getWebEnv } from "@/env";
import { logger } from "@/lib/logger";
import { USAGE_MAX_BODY_BYTES, usagePayloadSchema, verifyUsageRequest } from "@/lib/usage-ingest";
import { upsertTenantUsage } from "@/server/usage-ingest";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function POST(req: Request): Promise<Response> {
  const secret = getWebEnv().USAGE_INGEST_SECRET;
  if (!secret) return new Response("Not Found", { status: 404, headers: NO_STORE });
  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > USAGE_MAX_BODY_BYTES) return new Response("Payload Too Large", { status: 413, headers: NO_STORE });
  const raw = await req.text();
  const v = verifyUsageRequest(
    secret,
    { tenant: req.headers.get("x-bct-tenant"), ts: req.headers.get("x-bct-ts"), sig: req.headers.get("x-bct-sig") },
    raw,
    Math.floor(Date.now() / 1000),
  );
  if (!v.ok) {
    logger.warn({ reason: v.reason }, "usage ingest ditolak");
    return new Response("Unauthorized", { status: 401, headers: NO_STORE });
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return new Response("Bad Request", { status: 400, headers: NO_STORE });
  }
  const parsed = usagePayloadSchema.safeParse(body);
  if (!parsed.success) return new Response("Bad Request", { status: 400, headers: NO_STORE });
  const r = await upsertTenantUsage(getDb(), v.slug, parsed.data);
  if (r === "unknown_tenant") return new Response("Unauthorized", { status: 401, headers: NO_STORE });
  return Response.json({ status: r }, { headers: NO_STORE });
}
