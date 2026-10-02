/**
 * Integrasi SaaS Fase 1 (langkah 1, keputusan Lead): override harga per langganan, email cek tenant-admin hanya saat
 * himpunan berubah, plan opsional di form onboarding. Modul murni.
 */
import { describe, expect, it } from "vitest";
import { tenantOutcomeCode } from "@/jobs/tenants";
import {
  adminCheckKey,
  adminNotifyDecision,
  adminSetFingerprint,
  effectivePrice,
  fingerprintFromAdminKey,
} from "@/lib/billing";
import { parseBillingForm } from "@/lib/billing-forms";
import { ACTION_RESULT_CODES } from "@/lib/job-list-params";
import { parseOnboardingForm } from "@/lib/tenant-onboarding";

const S = "8d6c7a1e-1111-4222-8333-444455556666";
const P = "9d6c7a1e-1111-4222-8333-444455556666";
const entries = (o: Record<string, string>) => Object.entries(o) as [string, string][];

describe("effectivePrice: override langganan → harga plan → null", () => {
  it("override menang (mata uang override)", () => {
    expect(effectivePrice({ subscriptionPrice: "1500000.00", subscriptionCurrency: "USD", planPrice: "1000000.00", planCurrency: "IDR" })).toEqual({
      amount: "1500000.00",
      currency: "USD",
      source: "subscription",
    });
  });
  it("override 0 diabaikan (QA N4: tanpa invoice nol; CHECK DB menolak override 0) → harga plan", () => {
    expect(effectivePrice({ subscriptionPrice: "0.00", subscriptionCurrency: "IDR", planPrice: "1000000.00", planCurrency: "IDR" })?.source).toBe("plan");
  });
  it("tanpa override → plan; keduanya NULL → null", () => {
    expect(effectivePrice({ subscriptionPrice: null, subscriptionCurrency: null, planPrice: "750000.00", planCurrency: "IDR" })).toEqual({
      amount: "750000.00",
      currency: "IDR",
      source: "plan",
    });
    expect(effectivePrice({ subscriptionPrice: null, subscriptionCurrency: null, planPrice: null, planCurrency: "IDR" })).toBeNull();
  });
});

describe("cek tenant-admin: email hanya saat himpunan berubah", () => {
  const A = "11111111-1111-4111-8111-111111111111";
  const B = "22222222-2222-4222-8222-222222222222";
  it("sidik stabil terhadap urutan/duplikat; kosong = none", () => {
    expect(adminSetFingerprint([A, B])).toBe(adminSetFingerprint([B, A, A]));
    expect(adminSetFingerprint([A])).not.toBe(adminSetFingerprint([A, B]));
    expect(adminSetFingerprint([A])).toMatch(/^[0-9a-f]{16}$/);
    expect(adminSetFingerprint([])).toBe("none");
  });
  it("kunci notification_log lolos regex DB + sidik bisa dibaca ulang", () => {
    const fp = adminSetFingerprint([A]);
    const k = adminCheckKey("2026-10-03", fp);
    expect(k).toMatch(/^[a-z0-9_:./-]{3,200}$/);
    expect(fingerprintFromAdminKey(k)).toBe(fp);
    expect(fingerprintFromAdminKey(adminCheckKey("2026-10-03", "none"))).toBe("none");
    expect(fingerprintFromAdminKey("admin_check:2026-10-03")).toBeNull();
    expect(fingerprintFromAdminKey("reminder:x")).toBeNull();
  });
  it("keputusan: sama → none; berubah → email; kembali kosong → mark; belum pernah + kosong → none", () => {
    const a = adminSetFingerprint([A]);
    const ab = adminSetFingerprint([A, B]);
    expect(adminNotifyDecision(a, null)).toBe("email");
    expect(adminNotifyDecision(a, a)).toBe("none");
    expect(adminNotifyDecision(ab, a)).toBe("email");
    expect(adminNotifyDecision(a, ab)).toBe("email");
    expect(adminNotifyDecision("none", a)).toBe("mark");
    expect(adminNotifyDecision("none", null)).toBe("none");
    expect(adminNotifyDecision("none", "none")).toBe("none");
    expect(adminNotifyDecision(a, "none")).toBe("email");
  });
});

describe("form billing: override harga", () => {
  it("createSubscription: harga opsional + mata uang huruf besar", () => {
    const r = parseBillingForm("createSubscription", entries({ clientId: S, planId: P, price_amount: "2500000", price_currency: "idr" }));
    expect(r.success && r.data).toMatchObject({ price_amount: "2500000", price_currency: "IDR" });
    const kosong = parseBillingForm("createSubscription", entries({ clientId: S, planId: P, price_amount: "", price_currency: "IDR" }));
    expect(kosong.success && kosong.data.price_amount).toBeUndefined();
  });
  it("setSubscriptionPrice: kosong = hapus override; nominal/mata uang tak valid ditolak; field asing ditolak", () => {
    const clear = parseBillingForm("setSubscriptionPrice", entries({ subscriptionId: S, price_amount: "" }));
    expect(clear.success && clear.data).toEqual({ subscriptionId: S, price_amount: undefined, price_currency: "IDR" });
    expect(parseBillingForm("setSubscriptionPrice", entries({ subscriptionId: S, price_amount: "1.234" })).success).toBe(false);
    expect(parseBillingForm("setSubscriptionPrice", entries({ subscriptionId: S, price_amount: "-5" })).success).toBe(false);
    expect(parseBillingForm("setSubscriptionPrice", entries({ subscriptionId: S, price_amount: "1.000.000" })).success).toBe(false);
    expect(parseBillingForm("setSubscriptionPrice", entries({ subscriptionId: S, price_amount: "10", price_currency: "RUPIAH" })).success).toBe(false);
    expect(parseBillingForm("setSubscriptionPrice", entries({ subscriptionId: S, price_amount: "10", clientId: S })).success).toBe(false);
  });
});

describe("onboarding: plan opsional", () => {
  const base = { slug: "acme-co", name: "PT Acme", admin_email: "admin@acme.co.id", admin_name: "Budi" };
  it("plan_id kosong → null; uuid → diteruskan (diverifikasi ulang di server); bukan uuid → invalid", () => {
    const none = parseOnboardingForm("prod", entries({ ...base, plan_id: "" }));
    expect(none.success && none.data.planId).toBeNull();
    const withPlan = parseOnboardingForm("prod", entries({ ...base, plan_id: P }));
    expect(withPlan.success && withPlan.data.planId).toBe(P);
    expect(parseOnboardingForm("prod", entries({ ...base, plan_id: "odoo-shared-s" }))).toEqual({ success: false, issue: "invalid" });
  });
  it("plan_inactive dipetakan ke kode whitelist", () => {
    const code = tenantOutcomeCode({ ok: false, reason: "precondition", detail: "plan_inactive" });
    expect(code).toBe("plan_inactive");
    expect((ACTION_RESULT_CODES as readonly string[]).includes(code)).toBe(true);
  });
});
