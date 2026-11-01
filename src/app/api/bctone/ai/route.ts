/**
 * POST /api/bctone/ai — BCTOne AI gateway (consent dua jalur, kuota prompt/hari, masking PII). Nonaktif (404) bila
 * USAGE_INGEST_SECRET atau AI_UPSTREAM_URL kosong. Auth = HMAC per tenant dengan domain kunci `bctone-ai:` (berbeda dari
 * ingest pemakaian; header & format sama — lib/usage-ingest.ts). Respons tidak membocorkan isi upstream.
 */
import { getDb } from "@/db";
import { getWebEnv } from "@/env";
import { AI_MAX_BODY_BYTES, aiRequestSchema } from "@/lib/ai-gateway";
import { logger } from "@/lib/logger";
import { verifyTenantRequest } from "@/lib/usage-ingest";
import { runAiPrompt } from "@/ai/gateway";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function POST(req: Request): Promise<Response> {
  const env = getWebEnv();
  const secret = env.USAGE_INGEST_SECRET;
  if (!secret || !env.AI_UPSTREAM_URL) return new Response("Not Found", { status: 404, headers: NO_STORE });
  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > AI_MAX_BODY_BYTES) return new Response("Payload Too Large", { status: 413, headers: NO_STORE });
  const raw = await req.text();
  const v = verifyTenantRequest(
    secret,
    "bctone-ai",
    { tenant: req.headers.get("x-bct-tenant"), ts: req.headers.get("x-bct-ts"), sig: req.headers.get("x-bct-sig") },
    raw,
    Math.floor(Date.now() / 1000),
    AI_MAX_BODY_BYTES,
  );
  if (!v.ok) {
    logger.warn({ reason: v.reason }, "ai gateway ditolak");
    return new Response("Unauthorized", { status: 401, headers: NO_STORE });
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return new Response("Bad Request", { status: 400, headers: NO_STORE });
  }
  const parsed = aiRequestSchema.safeParse(body);
  if (!parsed.success) return new Response("Bad Request", { status: 400, headers: NO_STORE });
  const r = await runAiPrompt(getDb(), v.slug, parsed.data, {
    baseUrl: env.AI_UPSTREAM_URL,
    keys: { allow: env.AI_KEY_ALLOW, deny: env.AI_KEY_DENY },
  });
  logger.info({ tenant: v.slug, feature: parsed.data.feature, status: r.status, code: r.ok ? "ok" : r.code }, "ai gateway");
  if (!r.ok) return Response.json({ error: r.code }, { status: r.status, headers: NO_STORE });
  return Response.json(
    { consent: r.consent, model: r.model, content: r.content, quota: { used: r.used, limit: r.limit } },
    { headers: NO_STORE },
  );
}
