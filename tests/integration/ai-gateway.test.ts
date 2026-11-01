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
import { portalSetAiConsent } from "@/ai/portal-consent";
import { portalBctone } from "@/db/portal-queries";

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
    // paralel: slot Ollama tunggal → sebagian 429 busy; kuota tidak pernah terlampaui; slot busy dikembalikan
    const rs = await Promise.all(Array.from({ length: 6 }, () => runAiPrompt(db, "kopi-ai", REQ, up, NOW)));
    const okN = rs.filter((r) => r.ok).length;
    expect(okN).toBeGreaterThanOrEqual(1);
    expect(okN).toBeLessThanOrEqual(3);
    for (const r of rs) if (!r.ok) expect([r.status, ["busy", "quota_exceeded"].includes(r.code)]).toEqual([429, true]);
    // berurutan sampai kuota habis: tepat 3 sukses total, berikutnya quota_exceeded
    for (let i = okN; i < 3; i++) expect((await runAiPrompt(db, "kopi-ai", REQ, up, NOW)).ok).toBe(true);
    expect(await runAiPrompt(db, "kopi-ai", REQ, up, NOW)).toEqual({ ok: false, status: 429, code: "quota_exceeded" });
    expect(calls).toHaveLength(3);
    for (const c of calls) {
      expect(c.model).toBe("ollama-local/qwen2.5:3b");
      expect(c.auth).toBe("Bearer k-deny-xxxxxxxxxxxxx");
      expect(c.body).not.toContain("a@b.co");
      expect(c.body).toContain("[email]");
    }
    const d = (await db.select().from(tenantAiDaily).where(eq(tenantAiDaily.clientId, cid)))[0]!;
    expect([d.usageDate, d.prompts]).toEqual(["2026-11-01", 3]);
    expect(d.denied).toBeGreaterThanOrEqual(1);
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

  it("konkurensi jalur deny: slot Ollama tunggal → request bersamaan ditolak 429 busy, slot kuota dikembalikan", async () => {
    await setClientAiConsent(db, svc(), { clientId: cid, consent: "deny" });
    let releaseUp: () => void = () => undefined;
    const gate = new Promise<void>((r) => (releaseUp = r));
    const slowFetch = (async () => {
      await gate;
      return Response.json({ choices: [{ message: { content: "ok" } }] });
    }) as unknown as typeof fetch;
    const day = new Date("2026-11-05T03:00:00Z");
    const first = runAiPrompt(db, "kopi-ai", REQ, { ...up, fetchImpl: slowFetch }, day);
    await new Promise((r) => setTimeout(r, 150));
    const second = await runAiPrompt(db, "kopi-ai", REQ, { ...up, fetchImpl: slowFetch }, day);
    expect(second).toEqual({ ok: false, status: 429, code: "busy" });
    releaseUp();
    expect((await first).ok).toBe(true);
    const d = (await db.select().from(tenantAiDaily).where(eq(tenantAiDaily.usageDate, "2026-11-05")))[0]!;
    expect(d.prompts).toBe(1);
    // slot dilepas → request berikutnya lolos
    expect((await runAiPrompt(db, "kopi-ai", REQ, up, day)).ok).toBe(true);
  });

  it("Console: tenant-admin mengubah consent tenantnya sendiri; user lain/tenant lain ditolak", async () => {
    const other = (await db.insert(clients).values({ slug: "lain-co", name: "Lain" }).returning())[0]!.id;
    const [adm] = await db.insert(users).values({ keycloakSub: "adm-sub", role: "client_admin", clientId: cid, status: "active" }).returning();
    const [usr] = await db.insert(users).values({ keycloakSub: "usr-sub", role: "client_user", clientId: cid, status: "active" }).returning();
    const meta = { ip: null, requestId: "req-portal" };
    const A = { sub: "adm-sub", userId: adm!.id, roles: ["client_admin" as const] };
    expect(await portalSetAiConsent(db, { clientId: cid, userId: usr!.id, actor: { ...A, sub: "usr-sub", userId: usr!.id }, meta, consent: "allow" })).toEqual({ ok: false, reason: "forbidden" });
    expect(await portalSetAiConsent(db, { clientId: other, userId: adm!.id, actor: A, meta, consent: "allow" })).toEqual({ ok: false, reason: "forbidden" });
    expect(await portalSetAiConsent(db, { clientId: cid, userId: adm!.id, actor: A, meta, consent: "allow" })).toEqual({ ok: true, changed: true });
    const rows = await db.select().from(aiConsentLog).orderBy(asc(aiConsentLog.id));
    expect(rows.at(-1)!.actor).toBe("user:adm-sub");
    expect(verifyConsentChain(rows)).toBe(-1);
    const q = await portalBctone(db, cid, "2026-11-05");
    expect(q?.plan.code).toBe("bctone-free");
    expect(q?.consent).toBe("allow");
    expect(q?.limits.ai_prompts_per_day).toBe(3);
    expect(q?.aiToday).toBe(2);
    expect(await portalBctone(db, other, "2026-11-05")).toBeNull();
  });

  it("jalur izinkan: model cc/ + key allow", async () => {
    expect((await setClientAiConsent(db, svc(), { clientId: cid, consent: "allow" })).ok).toBe(true);
    calls.length = 0;
    const r = await runAiPrompt(db, "kopi-ai", REQ, up, new Date("2026-11-04T03:00:00Z"));
    expect(r).toMatchObject({ ok: true, consent: "allow", model: "cc/claude-haiku-4-5-20251001", content: "Jakarta", used: 1, limit: 3 });
    expect(calls[0]!.auth).toBe("Bearer k-allow-xxxxxxxxxxxx");
  });
});
