/**
 * QA ronde 2 (keputusan Lead) — bagian murni: N4 nominal > 0 (form + effectivePrice), N5 akses Odoo portal none|user,
 * N6 kanal portal mensyaratkan baris DB client_admin active. N1/N3/N7 di saas-p1-tenants.test.ts; N2/N8 di integrasi.
 */
import { describe, expect, it } from "vitest";
import { effectivePrice, isPositiveAmount } from "@/lib/billing";
import { parseBillingForm } from "@/lib/billing-forms";
import type { Role } from "@/lib/roles";
import { authorizeUserMutation, type TargetUser, type TenantRef, type UserActorContext } from "@/lib/user-admin";
import { parseUserForm } from "@/lib/user-forms";

const C = "11111111-1111-4111-8111-111111111111";
const S = "8d6c7a1e-1111-4222-8333-444455556666";
const E = "77777777-7777-4777-8777-777777777777";
const entries = (o: Record<string, string>) => Object.entries(o) as [string, string][];

describe("N4: tidak ada nominal nol", () => {
  it("isPositiveAmount", () => {
    for (const v of ["1", "0.01", "1500000", "10.5"]) expect(isPositiveAmount(v), v).toBe(true);
    for (const v of ["0", "0.0", "0.00", "", "-1", "1.234", "01", null, undefined]) expect(isPositiveAmount(v as string), String(v)).toBe(false);
  });
  it("form: invoice 0 dan override harga 0 ditolak", () => {
    const inv = (amount: string) => parseBillingForm("issueInvoice", entries({ clientId: C, subscriptionId: "", kind: "implementation", amount, dueAt: "2026-10-17" }));
    expect(inv("0").success).toBe(false);
    expect(inv("0.00").success).toBe(false);
    expect(inv("1").success).toBe(true);
    expect(parseBillingForm("setSubscriptionPrice", entries({ subscriptionId: S, price_amount: "0" })).success).toBe(false);
    expect(parseBillingForm("createSubscription", entries({ clientId: C, planId: S, price_amount: "0.00", price_currency: "IDR" })).success).toBe(false);
    // kosong = hapus override tetap boleh
    expect(parseBillingForm("setSubscriptionPrice", entries({ subscriptionId: S, price_amount: "" })).success).toBe(true);
  });
  it("effectivePrice: harga plan 0 = belum ditetapkan (tanpa invoice nol)", () => {
    expect(effectivePrice({ subscriptionPrice: null, subscriptionCurrency: null, planPrice: "0.00", planCurrency: "IDR" })).toBeNull();
    expect(effectivePrice({ subscriptionPrice: "0.00", subscriptionCurrency: "IDR", planPrice: "5.00", planCurrency: "IDR" })?.source).toBe("plan");
  });
});

describe("N5: portal hanya akses Odoo none|user", () => {
  it("form portal menolak admin; form platform tetap boleh admin", () => {
    expect(parseUserForm("portalAddUser", entries({ email: "a@acme.co.id", [`odoo_${E}`]: "admin" }), { portal: true })).toEqual({ success: false, issue: "invalid" });
    expect(parseUserForm("portalChangeAccess", entries({ userId: S, [`odoo_${E}`]: "admin" }), { portal: true })).toEqual({ success: false, issue: "invalid" });
    expect(parseUserForm("enableUser", entries({ userId: S, [`odoo_${E}`]: "admin" }), { portal: true })).toEqual({ success: false, issue: "invalid" });
    expect(parseUserForm("portalChangeAccess", entries({ userId: S, [`odoo_${E}`]: "user" }), { portal: true }).success).toBe(true);
    expect(parseUserForm("changeAccess", entries({ userId: S, cp_role: "client_user", [`odoo_${E}`]: "admin" })).success).toBe(true);
  });
});

describe("N6: kanal portal butuh baris DB client_admin + active", () => {
  const ACME: TenantRef = { id: C, slug: "acme-co", isPlatform: false, terminated: false };
  const target: TargetUser = { id: S, keycloakSub: "t", email: "t@acme.co.id", role: "client_user", status: "active", clientId: C };
  const actor = (over: Partial<UserActorContext>): UserActorContext => ({ sub: "ca", roles: ["client_admin"] as Role[], userId: "x", clientId: C, status: "active", role: "client_admin", ...over });
  const portal = { otherActiveAdmins: 1, channel: "portal" as const };
  it("JWT client_admin tetapi baris DB diturunkan / invited / tanpa role → forbidden", () => {
    expect(authorizeUserMutation(actor({}), ACME, { kind: "disable", target }, portal)).toEqual({ ok: true, scope: "own" });
    for (const over of [{ role: "client_user" as const }, { role: null }, { role: undefined }, { status: "invited" as const }, { status: null }]) {
      expect(authorizeUserMutation(actor(over), ACME, { kind: "disable", target }, portal), JSON.stringify(over)).toEqual({ ok: false, reason: "forbidden" });
    }
    expect(authorizeUserMutation(actor({ status: "disabled" }), ACME, { kind: "disable", target }, portal)).toEqual({ ok: false, reason: "actor_disabled" });
  });
});
