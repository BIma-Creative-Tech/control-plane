/**
 * Regresi QA J5 (docs/qa/2026-09-25-plan05-staging.md): BUG-J5-01, BUG-J5-02, OBS-J5-01, OBS-J5-02.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { planReconcile, ssoUserActionMismatch, type ReconcileJob } from "@/jobs/reconcile";
import { applySignInIdentity, isValidSub, sessionUserId, subFromSignIn } from "@/lib/identity";
import { ACTOR_REGEX, ERROR_CODES, INVITE_FACTS, inviteFact, parseResultFile, sanitizeResult, sanitizeTail } from "@/lib/job-contract";
import { resendAllowedForStatus, ssoUserRowActions } from "@/lib/job-forms";
import { ACTION_RESULT_TEXT, parseActionResult } from "@/lib/job-list-params";
import { isForeignOriginMutation } from "@/lib/origin";

const KC_SUB = "bf06fc2d-1234-4abc-8def-0123456789ab";
const RANDOM_AUTHJS_ID = "16bef5ca-0000-4000-8000-000000000000";

describe("BUG-J5-02: identitas aktor = sub Keycloak", () => {
  it("subFromSignIn memakai profile.sub (= providerAccountId), bukan user.id acak Auth.js", () => {
    expect(subFromSignIn({ sub: KC_SUB, email: "x@y.z" }, { providerAccountId: KC_SUB })).toBe(KC_SUB);
    expect(subFromSignIn({ sub: KC_SUB }, {})).toBe(KC_SUB);
  });
  it("sub tidak valid / tidak cocok dengan providerAccountId → null", () => {
    expect(subFromSignIn({}, { providerAccountId: KC_SUB })).toBeNull();
    expect(subFromSignIn({ sub: "a b" }, {})).toBeNull();
    expect(subFromSignIn({ sub: "x".repeat(129) }, {})).toBeNull();
    expect(subFromSignIn({ sub: KC_SUB }, { providerAccountId: RANDOM_AUTHJS_ID })).toBeNull();
    expect(subFromSignIn(null, null)).toBeNull();
  });
  it("applySignInIdentity menimpa token.sub acak dan menandai kcSub; stabil antar login", () => {
    const login1 = applySignInIdentity({ sub: RANDOM_AUTHJS_ID, name: "ops" } as Record<string, unknown>, KC_SUB);
    const login2 = applySignInIdentity({ sub: "36196936-0000-4000-8000-000000000000" } as Record<string, unknown>, KC_SUB);
    expect(login1).toMatchObject({ sub: KC_SUB, kcSub: KC_SUB, name: "ops" });
    expect(sessionUserId(login1)).toBe(KC_SUB);
    expect(sessionUserId(login2)).toBe(sessionUserId(login1));
  });
  it("sign-in tanpa sub valid → token tanpa identitas (UUID acak tidak pernah jadi aktor)", () => {
    const t = applySignInIdentity({ sub: RANDOM_AUTHJS_ID } as Record<string, unknown>, null);
    expect(t.sub).toBeUndefined();
    expect(sessionUserId(t)).toBeNull();
  });
  it("sesi lama (token tanpa kcSub, sub = UUID acak) → null → aksi minta login ulang (reauth)", () => {
    expect(sessionUserId({ sub: RANDOM_AUTHJS_ID })).toBeNull();
    expect(sessionUserId({ sub: RANDOM_AUTHJS_ID, kcSub: KC_SUB })).toBeNull();
    expect(parseActionResult("reauth")).toBe("reauth");
    expect(ACTION_RESULT_TEXT.reauth).toMatch(/login ulang/);
  });
  it("aktor file job `user:<sub Keycloak>` lolos ACTOR_REGEX dispatcher (UUID dan id federasi)", () => {
    expect(ACTOR_REGEX.test(`user:${KC_SUB}`)).toBe(true);
    expect(ACTOR_REGEX.test(`user:f:3d2c1b0a-ldap:jdoe`)).toBe(true);
    expect(`user:${KC_SUB}`.length).toBeLessThanOrEqual(140);
    expect(isValidSub(KC_SUB)).toBe(true);
  });
});

describe("BUG-J5-01: resend_invite hanya untuk user active + rekonsiliasi dari RESULT action", () => {
  it("kebijakan status (dipakai UI dan server)", () => {
    expect(resendAllowedForStatus("active")).toBe(true);
    for (const s of ["revoked", "pending", "failed", "inconsistent", null, undefined]) expect(resendAllowedForStatus(s)).toBe(false);
    expect(ssoUserRowActions("revoked")).toEqual([]);
    expect(ssoUserRowActions("active")).toEqual(["revoke", "resend_invite"]);
    expect(ssoUserRowActions("failed")).toEqual(["revoke"]);
    expect(ssoUserRowActions("inconsistent")).toEqual(["revoke"]);
  });

  const env = { dbName: "acme_co_prod" };
  const resend: ReconcileJob = {
    id: "22222222-2222-4222-8222-222222222222",
    type: "odoo_sso_user",
    env: "prod",
    dryRun: false,
    args: { action: "resend_invite", email: "a@b.co", admin: false, create_kc: false },
    status: "succeeded",
    result: { kc_user: "33333333-3333-4333-8333-333333333333", odoo_user: "5", action: "resend_invite", changed: "0" },
  };

  it("resend_invite dengan RESULT action=resend_invite → tidak mengubah status (id saja)", () => {
    const p = planReconcile(resend, env);
    expect(p.inconsistent).toBeUndefined();
    expect(p.tenantUser).toEqual({ email: "a@b.co", set: { kcUserId: "33333333-3333-4333-8333-333333333333", odooUserId: 5 } });
  });

  it("resend_invite dengan RESULT action=grant (bug skrip lama) → inconsistent, bukan dipercaya diam-diam", () => {
    const p = planReconcile({ ...resend, result: { ...resend.result, action: "grant", changed: "1" } }, env);
    expect(p.inconsistent).toEqual({ expected: "resend_invite", reported: "grant" });
    expect(p.tenantUser?.set.status).toBe("inconsistent");
    expect(p.tenantUser?.onlyIfPending).toBeUndefined();
  });

  it("revoke dilaporkan grant, grant dilaporkan revoke → inconsistent", () => {
    expect(planReconcile({ ...resend, args: { action: "revoke", email: "a@b.co" }, result: { action: "grant" } }, env).inconsistent).toEqual({
      expected: "revoke",
      reported: "grant",
    });
    expect(planReconcile({ ...resend, args: { action: "grant", email: "a@b.co" }, result: { action: "revoke" } }, env).tenantUser?.set.status).toBe(
      "inconsistent",
    );
  });

  it("apply sukses tanpa RESULT action → inconsistent (status tidak bisa diturunkan dari RESULT)", () => {
    const p = planReconcile({ ...resend, args: { action: "grant", email: "a@b.co" }, result: { kc_user: "-", changed: "1" } }, env);
    expect(p.inconsistent).toEqual({ expected: "grant", reported: null });
    expect(p.tenantUser?.set.status).toBe("inconsistent");
  });

  it("dry-run dengan action tidak cocok → job ditandai, baris akses tidak disentuh", () => {
    const p = planReconcile({ ...resend, dryRun: true, result: { action: "grant", mode: "dry-run", blockers: "0" } }, env);
    expect(p.inconsistent).toEqual({ expected: "resend_invite", reported: "grant" });
    expect(p.tenantUser).toBeUndefined();
  });

  it("resend gagal blocked_dry_run (user tanpa role, perilaku skrip baru) → normal, status tidak berubah", () => {
    const failed = { ...resend, status: "failed" as const, result: { mode: "dry-run", blockers: "1", action: "resend_invite" } };
    const p = planReconcile(failed, env);
    expect(p.inconsistent).toBeUndefined();
    expect(p.tenantUser).toBeUndefined();
    expect(ssoUserActionMismatch({ ...failed, result: {} }, false)).toBeNull();
  });

  it("result_inconsistent adalah error_code CP (bukan dari file hasil dispatcher)", () => {
    expect(ERROR_CODES).toContain("result_inconsistent");
    const text = JSON.stringify({ v: 1, job_id: resend.id, state: "failed", exit_code: 1, error_code: "result_inconsistent", result: {}, tail: [] });
    expect(parseResultFile(text, resend.id)).toMatchObject({ errorCode: "script_exit", unknownErrorCode: true });
  });
});

describe("OBS-J5-01: fakta undangan ter-allowlist, redaksi tail tidak dilonggarkan", () => {
  it("RESULT invite=sent diteruskan; tail UPDATE_PASSWORD tetap [redacted]", () => {
    expect(sanitizeResult({ invite: "sent", action: "resend_invite", secret: "x" })).toEqual({ invite: "sent", action: "resend_invite" });
    expect(sanitizeResult({ invite: "sent now" })).toEqual({});
    expect(sanitizeTail(['UBAH: execute-actions-email ["UPDATE_PASSWORD"] user x'])).toEqual(["[redacted]"]);
  });
  it("inviteFact: nilai dikenal → teks; lain → unknown; tidak ada → null", () => {
    expect(inviteFact({ invite: "sent" })).toBe("sent");
    expect(INVITE_FACTS.sent).toMatch(/terkirim/);
    expect(inviteFact({ invite: "none" })).toBe("none");
    expect(inviteFact({ invite: "queued" })).toBe("unknown");
    expect(inviteFact({ action: "grant" })).toBeNull();
    expect(inviteFact(null)).toBeNull();
  });
});

describe("OBS-J5-02: Origin asing pada mutasi → 403 di proxy (bukan 500)", () => {
  const APP = "https://cp.staging.bimacreative.tech";
  it("isForeignOriginMutation", () => {
    expect(isForeignOriginMutation("POST", "https://evil.example", APP)).toBe(true);
    expect(isForeignOriginMutation("POST", "https://cp.bimacreative.tech", APP)).toBe(true);
    expect(isForeignOriginMutation("POST", "null", APP)).toBe(true);
    expect(isForeignOriginMutation("post", "https://evil.example", APP)).toBe(true);
    expect(isForeignOriginMutation("POST", APP, APP)).toBe(false);
    // Tanpa Origin: diteruskan ke action (assertSameOrigin → 303 ?r=origin, perilaku lama).
    expect(isForeignOriginMutation("POST", null, APP)).toBe(false);
    expect(isForeignOriginMutation("GET", "https://evil.example", APP)).toBe(false);
    // AUTH_URL tidak tersedia → fail-closed untuk mutasi ber-Origin.
    expect(isForeignOriginMutation("POST", APP, null)).toBe(true);
  });

  describe("proxy()", () => {
    beforeAll(() => {
      vi.stubEnv("NODE_ENV", "test");
      vi.stubEnv("DATABASE_URL", "postgresql://u:p@localhost:5432/db");
      vi.stubEnv("AUTH_SECRET", "x".repeat(40));
      vi.stubEnv("AUTH_URL", APP);
      vi.stubEnv("AUTH_KEYCLOAK_ID", "control-plane");
      vi.stubEnv("AUTH_KEYCLOAK_SECRET", "y".repeat(20));
      vi.stubEnv("AUTH_KEYCLOAK_ISSUER", "https://auth.bimacreative.tech/realms/platform-staging");
    });
    afterAll(() => {
      vi.unstubAllEnvs();
    });
    const req = async (method: string, origin?: string) => {
      const { NextRequest } = await import("next/server");
      const { proxy } = await import("@/proxy");
      const headers: Record<string, string> = { "content-type": "multipart/form-data; boundary=x" };
      if (origin) headers.origin = origin;
      return proxy(new NextRequest(`${APP}/environments/11111111-1111-4111-8111-111111111111`, { method, headers }));
    };
    it("POST Origin asing → 403 tanpa meneruskan request", async () => {
      const r = await req("POST", "https://evil.example");
      expect(r.status).toBe(403);
      expect(r.headers.get("x-middleware-next")).toBeNull();
      expect(r.headers.get("cache-control")).toBe("no-store");
      expect(await r.text()).toBe("Forbidden");
    });
    it("POST Origin instance lain (prod ke staging) → 403", async () => {
      expect((await req("POST", "https://cp.bimacreative.tech")).status).toBe(403);
    });
    it("POST Origin benar / tanpa Origin / GET → diteruskan (x-middleware-next)", async () => {
      for (const r of [await req("POST", APP), await req("POST"), await req("GET", "https://evil.example")]) {
        expect(r.status).toBe(200);
        expect(r.headers.get("x-middleware-next")).toBe("1");
      }
    });
  });
});
