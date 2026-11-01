/** BCTOne AI gateway — logika (tanpa `server-only` agar bisa diuji integrasi; dipanggil hanya dari route handler). */
import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { clients, planQuotas, subscriptions, tenantAiDaily } from "@/db/schema";
import { AI_DEFAULT_MODELS, AI_TIMEOUT_MS, maskPii, modelAllowedFor, type AiConsent, type AiRequest } from "@/lib/ai-gateway";
import { jakartaDate } from "@/lib/billing";

export type AiGatewayResult =
  | { ok: true; status: 200; consent: AiConsent; model: string; content: string; used: number; limit: number | null }
  | { ok: false; status: 401 | 403 | 429 | 502 | 504; code: string };

/** Batas prompt/hari dari plan langganan aktif (self-serve); tanpa baris kuota = tanpa batas; tanpa langganan = 0. */
async function promptLimit(db: Db, clientId: string): Promise<number | null> {
  const r = (
    await db
      .select({ planId: subscriptions.planId })
      .from(subscriptions)
      .where(and(eq(subscriptions.clientId, clientId), sql`${subscriptions.status} IN ('active','past_due')`))
      .orderBy(desc(subscriptions.createdAt))
      .limit(1)
  )[0];
  if (!r) return 0;
  const q = (
    await db
      .select({ limit: planQuotas.limitValue })
      .from(planQuotas)
      .where(and(eq(planQuotas.planId, r.planId), eq(planQuotas.metric, "ai_prompts_per_day")))
      .limit(1)
  )[0];
  return q ? q.limit : null;
}

export interface UpstreamConfig {
  baseUrl: string;
  keys: Record<AiConsent, string | undefined>;
  fetchImpl?: typeof fetch;
}

/**
 * Satu prompt: consent → kuota harian (atomik, slot dipesan sebelum upstream; dikembalikan bila upstream gagal) →
 * masking PII → 9router (key per jalur). Jalur `deny` tidak pernah dialihkan ke model lain.
 */
export async function runAiPrompt(db: Db, slug: string, req: AiRequest, up: UpstreamConfig, now = new Date()): Promise<AiGatewayResult> {
  const c = (await db.select({ id: clients.id, status: clients.status, consent: clients.aiConsent }).from(clients).where(eq(clients.slug, slug)).limit(1))[0];
  if (!c || c.status !== "active") return { ok: false, status: 401, code: "unknown_tenant" };
  if (!c.consent) return { ok: false, status: 403, code: "consent_required" };
  const key = up.keys[c.consent];
  if (!key) return { ok: false, status: 502, code: "route_unconfigured" };
  const model = AI_DEFAULT_MODELS[c.consent];
  if (!modelAllowedFor(c.consent, model)) return { ok: false, status: 403, code: "model_forbidden" };

  const limit = await promptLimit(db, c.id);
  const day = jakartaDate(now);
  // pesan slot: baris dibuat bila belum ada; increment hanya bila masih di bawah batas (kondisi di WHERE = atomik)
  await db.insert(tenantAiDaily).values({ clientId: c.id, usageDate: day }).onConflictDoNothing();
  const booked = await db
    .update(tenantAiDaily)
    .set({ prompts: sql`${tenantAiDaily.prompts} + 1` })
    .where(
      and(
        eq(tenantAiDaily.clientId, c.id),
        eq(tenantAiDaily.usageDate, day),
        ...(limit === null ? [] : [sql`${tenantAiDaily.prompts} < ${limit}`]),
      ),
    )
    .returning({ prompts: tenantAiDaily.prompts });
  if (booked.length === 0) {
    await db
      .update(tenantAiDaily)
      .set({ denied: sql`${tenantAiDaily.denied} + 1` })
      .where(and(eq(tenantAiDaily.clientId, c.id), eq(tenantAiDaily.usageDate, day)));
    return { ok: false, status: 429, code: "quota_exceeded" };
  }
  const used = booked[0]!.prompts;
  const release = () =>
    db
      .update(tenantAiDaily)
      .set({ prompts: sql`GREATEST(${tenantAiDaily.prompts} - 1, 0)` })
      .where(and(eq(tenantAiDaily.clientId, c.id), eq(tenantAiDaily.usageDate, day)));

  const body = {
    model,
    stream: false,
    max_tokens: req.max_tokens,
    messages: req.messages.map((m) => ({ role: m.role, content: maskPii(m.content) })),
  };
  const f = up.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await f(`${up.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(AI_TIMEOUT_MS[c.consent]),
    });
  } catch (e) {
    await release();
    const timeout = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    return { ok: false, status: timeout ? 504 : 502, code: timeout ? "upstream_timeout" : "upstream_error" };
  }
  if (!res.ok) {
    await release();
    return { ok: false, status: 502, code: `upstream_${res.status}` };
  }
  const j = (await res.json().catch(() => null)) as { choices?: { message?: { content?: unknown } }[] } | null;
  const content = j?.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    await release();
    return { ok: false, status: 502, code: "upstream_bad_body" };
  }
  return { ok: true, status: 200, consent: c.consent, model, content, used, limit };
}
