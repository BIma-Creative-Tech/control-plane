/** BCTOne AI gateway — logika (tanpa `server-only` agar bisa diuji integrasi; dipanggil hanya dari route handler). */
import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { clients, planQuotas, subscriptions, tenantAiDaily } from "@/db/schema";
import { AI_DEFAULT_MODELS, AI_TIMEOUT_MS, maskPii, modelAllowedFor, type AiConsent, type AiRequest } from "@/lib/ai-gateway";
import { jakartaDate } from "@/lib/billing";

export type AiGatewayResult =
  | { ok: true; status: 200; consent: AiConsent; model: string; content: string; used: number; limit: number | null }
  | { ok: false; status: 401 | 403 | 429 | 502 | 504; code: string };

/**
 * Batas konkurensi upstream (advisory lock sesi, non-blok, di koneksi khusus): jalur `deny` = slot global Ollama VPS
 * (CPU 4 vCPU, 1 model 3B → satu-satu), jalur `allow` = maks AI_ALLOW_PER_TENANT per tenant. Tidak menunggu antrean:
 * slot penuh → 429 `busy` (klien mencoba lagi), slot kuota dikembalikan.
 */
export const AI_DENY_SLOTS = 1;
export const AI_ALLOW_PER_TENANT = 2;
const LOCK_NS = 0x0b47_0a1; // namespace advisory lock gateway AI

function slotKeys(consent: AiConsent, clientId: string): [number, number][] {
  if (consent === "deny") return Array.from({ length: AI_DENY_SLOTS }, (_, i) => [LOCK_NS, i]);
  // hash client → int4; slot i per tenant
  let h = 0;
  for (const ch of clientId) h = (Math.imul(h, 31) + ch.charCodeAt(0)) | 0;
  return Array.from({ length: AI_ALLOW_PER_TENANT }, (_, i) => [LOCK_NS + 1 + i, h]);
}

async function withSlot<T>(db: Db, consent: AiConsent, clientId: string, fn: () => Promise<T>): Promise<T | "busy"> {
  const pool = (db as unknown as { $client: { connect: () => Promise<{ query: (q: string, v: unknown[]) => Promise<{ rows: { ok: boolean }[] }>; release: () => void }> } }).$client;
  const conn = await pool.connect();
  try {
    for (const [a, b] of slotKeys(consent, clientId)) {
      const got = (await conn.query("SELECT pg_try_advisory_lock($1, $2) AS ok", [a, b])).rows[0]?.ok === true;
      if (!got) continue;
      try {
        return await fn();
      } finally {
        await conn.query("SELECT pg_advisory_unlock($1, $2)", [a, b]);
      }
    }
    return "busy";
  } finally {
    conn.release();
  }
}

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
  const consent = c.consent;
  if (!consent) return { ok: false, status: 403, code: "consent_required" };
  const key = up.keys[consent];
  if (!key) return { ok: false, status: 502, code: "route_unconfigured" };
  const model = AI_DEFAULT_MODELS[consent];
  if (!modelAllowedFor(consent, model)) return { ok: false, status: 403, code: "model_forbidden" };

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

  const r = await withSlot(db, consent, c.id, async (): Promise<AiGatewayResult> => {
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
        signal: AbortSignal.timeout(AI_TIMEOUT_MS[consent]),
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
    return { ok: true, status: 200, consent, model, content, used, limit };
  });
  if (r === "busy") {
    await release();
    return { ok: false, status: 429, code: "busy" };
  }
  return r;
}
