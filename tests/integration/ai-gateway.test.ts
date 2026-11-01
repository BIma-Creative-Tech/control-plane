/**
 * Integrasi BCTOne AI gateway: consent hash-chain (append-only, trigger), kuota prompt/hari atomik (paralel), jalur tolak
 * tanpa fallback, slot dikembalikan bila upstream gagal. Postgres SEKALI PAKAI (TEST_DATABASE_URL; skema di-DROP).
 */
import { asc, eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSubscription, setClientAiConsent, type BillingServiceInput } from "@/billing/service";
import { createDb, type Db } from "@/db/client";
import { ensureBctonePlans, ensureInitialPlans } from "@/db/plans";
import { ensurePlatformTenant } from "@/db/platform";
import { aiConsentLog, clients, plans, tenantAiDaily, users } from "@/db/schema";
import type { Actor, SendFn } from "@/jobs/service";
import { verifyConsentChain } from "@/lib/ai-gateway";
import { BRIDGE_JOB_TYPES } from "@/lib/job-contract";
import { runAiPrompt } from "@/ai/gateway";

const URL_ = process.env.TEST_DATABASE_URL;
const REQ = { request_id: "3f2c7a9e-1b4d-4e8a-9c3f-5a6b7c8d9e0f", feature: "assistant" as const, messages: [{ role: "user" as const, content: "email saya a@b.co, ibukota?" }], max_tokens: 64 };
const NOW = new Date("2026-11-01T10:00:00Z");

describe.skipIf(!URL_)("BCTOne AI gateway", () => {
  let db: Db;
  let pool: { end: () => Promise<void> };
  let SUPER: Actor;
  let cid: string;
  const send: SendFn = async () => "unused";
  const svc = (): BillingServiceInput => ({ actor: SUPER, meta: { ip: "203.0.113.9", requestId: "req-ai" }, instance: "staging", allowedTypes: [...BRIDGE_JOB_TYPES], send });
  const calls: { model: string; auth: string; body: string }[] = [];
  let fail = false;
  const fakeFetch = (async (_url: string, init: RequestInit) => {
    const b = JSON.parse(init.body as string) as { model: string };
    calls.push({ model: b.model, auth: (init.headers as Record<string, string>).authorization ?? "", body: init.body as string });
    await new Promise((r) => setTimeout(r, 5));
    if (fail) return new Response("x", { status: 503 });
    return Response.json({ choices: [{ message: { content: "Jakarta" } }] });
  }) as unknown as typeof fetch;
  const up = { baseUrl: "https://router.example/v1", keys: { allow: "k-allow-xxxxxxxxxxxx", deny: "k-deny-xxxxxxxxxxxxx" }, fetchImpl: fakeFetch };

  beforeAll(async () => {
    ({ db, pool } = createDb(URL_!, { max: 6, applicationName: "cp-int-ai" }));
    await db.execute(sql`DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA IF EXISTS pgboss CASCADE; CREATE SCHEMA public;`);
    await migrate(db, { migrationsFolder: "./drizzle" });
    const platform = await ensurePlatformTenant(db);
    await ensureInitialPlans(db);
    await ensureBctonePlans(db);
    cid = (await db.insert(clients).values({ slug: "kopi-ai", name: "Kopi AI" }).returning())[0]!.id;
    const [sa] = await db.insert(users).values({ keycloakSub: "super-sub", role: "superadmin", clientId: platform.id }).returning();
    SUPER = { sub: "super-sub", userId: sa!.id, roles: ["superadmin"] };
    const free = (await db.select().from(plans).where(eq(plans.code, "bctone-free")))[0]!;
    expect((await createSubscription(db, svc(), { clientId: cid, planId: free.id })).ok).toBe(true);
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
  });

  it("tanpa consent → 403, tidak memanggil upstream", async () => {
    expect(await runAiPrompt(db, "kopi-ai", REQ, up, NOW)).toEqual({ ok: false, status: 403, code: "consent_required" });
    expect(calls).toHaveLength(0);
  });

  it("consent tercatat hash-chain; UPDATE/DELETE ditolak trigger", async () => {
    expect((await setClientAiConsent(db, svc(), { clientId: cid, consent: "allow" })).ok).toBe(true);
    expect((await setClientAiConsent(db, svc(), { clientId: cid, consent: "deny" })).ok).toBe(true);
    const rows = await db.select().from(aiConsentLog).orderBy(asc(aiConsentLog.id));
    expect(rows.map((r) => r.consent)).toEqual(["allow", "deny"]);
    expect(verifyConsentChain(rows)).toBe(-1);
    expect((await db.select({ c: clients.aiConsent }).from(clients).where(eq(clients.id, cid)))[0]!.c).toBe("deny");
    const cause = async (q: Promise<unknown>) => {
      try {
        await q;
        return "tidak ditolak";
      } catch (e) {
        return String((e as { cause?: { message?: string } }).cause?.message ?? e);
      }
    };
    expect(await cause(db.execute(sql`UPDATE ai_consent_log SET consent = 'allow'`))).toMatch(/append-only/);
    expect(await cause(db.execute(sql`DELETE FROM ai_consent_log`))).toMatch(/append-only/);
    expect(await cause(db.execute(sql`TRUNCATE ai_consent_log`))).toMatch(/append-only/);
    expect(await db.$count(aiConsentLog)).toBe(2);
  });

  it("jalur tolak: ollama-local + key deny, PII dimasking; kuota Free 3/hari atomik di bawah paralel", async () => {
    const rs = await Promise.all(Array.from({ length: 6 }, () => runAiPrompt(db, "kopi-ai", REQ, up, NOW)));
    expect(rs.filter((r) => r.ok)).toHaveLength(3);
    expect(rs.filter((r) => !r.ok && r.status === 429)).toHaveLength(3);
    expect(calls).toHaveLength(3);
    for (const c of calls) {
      expect(c.model).toBe("ollama-local/qwen2.5:3b");
      expect(c.auth).toBe("Bearer k-deny-xxxxxxxxxxxxx");
      expect(c.body).not.toContain("a@b.co");
      expect(c.body).toContain("[email]");
    }
    const d = (await db.select().from(tenantAiDaily).where(eq(tenantAiDaily.clientId, cid)))[0]!;
    expect([d.usageDate, d.prompts, d.denied]).toEqual(["2026-11-01", 3, 3]);
    // hari berikutnya (WIB) reset
    const next = await runAiPrompt(db, "kopi-ai", REQ, up, new Date("2026-11-01T17:00:00Z"));
    expect(next.ok).toBe(true);
  });

  it("upstream gagal → 502, slot dikembalikan; jalur deny tidak beralih ke Claude", async () => {
    fail = true;
    calls.length = 0;
    const day3 = new Date("2026-11-02T17:30:00Z");
    expect(await runAiPrompt(db, "kopi-ai", REQ, up, day3)).toMatchObject({ ok: false, status: 502 });
    expect(calls.map((c) => c.model)).toEqual(["ollama-local/qwen2.5:3b"]);
    const d = (await db.select().from(tenantAiDaily).where(eq(tenantAiDaily.usageDate, "2026-11-03")))[0]!;
    expect(d.prompts).toBe(0);
    fail = false;
    expect(await runAiPrompt(db, "kopi-ai", REQ, { ...up, keys: { allow: up.keys.allow, deny: undefined } }, day3)).toEqual({
      ok: false,
      status: 502,
      code: "route_unconfigured",
    });
  });

  it("jalur izinkan: model cc/ + key allow", async () => {
    expect((await setClientAiConsent(db, svc(), { clientId: cid, consent: "allow" })).ok).toBe(true);
    calls.length = 0;
    const r = await runAiPrompt(db, "kopi-ai", REQ, up, new Date("2026-11-04T03:00:00Z"));
    expect(r).toMatchObject({ ok: true, consent: "allow", model: "cc/claude-haiku-4-5-20251001", content: "Jakarta", used: 1, limit: 3 });
    expect(calls[0]!.auth).toBe("Bearer k-allow-xxxxxxxxxxxx");
  });
});
