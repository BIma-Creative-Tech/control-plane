/** D-1 + ADR 0019: aturan paket BCTOne & form admin (murni). */
import { describe, expect, it } from "vitest";
import { isBctonePlanCode, selfServeStart } from "@/lib/bctone-plans";
import { parseBillingForm } from "@/lib/billing-forms";
import { can } from "@/lib/roles";

const UUID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const entries = (o: object) => Object.entries(o) as [string, string][];

describe("bctone-plans", () => {
  it("kode paket", () => {
    expect(isBctonePlanCode("bctone-free")).toBe(true);
    expect(isBctonePlanCode("bctone-")).toBe(false);
    expect(isBctonePlanCode("odoo-shared-m")).toBe(false);
  });
  it("periode self-serve", () => {
    expect(selfServeStart("2026-01-31", 1)).toEqual({ startsAt: "2026-01-31", endsAt: "2026-02-28" });
    expect(() => selfServeStart("2026-01-01", 0)).toThrow(RangeError);
  });
});

describe("form updatePlan", () => {
  const base = { planId: UUID, price_amount: "199000", limit_users: "5", limit_devices: "", limit_outlets: "2",
    limit_trx_per_month: "5000", limit_omzet_per_month: "", limit_ai_prompts_per_day: "30" };
  it("valid; kosong = tanpa batas; tanpa checkbox = nonaktif", () => {
    const r = parseBillingForm("updatePlan", entries(base));
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.price_amount).toBe("199000");
    expect(r.data.is_active).toBeUndefined();
    expect((r.data as Record<string, unknown>).limit_devices).toBeNull();
    expect((r.data as Record<string, unknown>).limit_users).toBe(5);
  });
  it("harga kosong = gratis; is_active on", () => {
    const r = parseBillingForm("updatePlan", entries({ ...base, price_amount: "", is_active: "on" }));
    expect(r.success && r.data.price_amount === undefined && r.data.is_active === "on").toBe(true);
  });
  it("menolak negatif, desimal, terlalu besar, field asing", () => {
    for (const bad of [{ limit_users: "-1" }, { limit_users: "1.5" }, { limit_users: "1000000000000" }, { extra: "x" }, { limit_users: "01" }]) {
      expect(parseBillingForm("updatePlan", entries({ ...base, ...bad })).success).toBe(false);
    }
  });
});

describe("form setClientWithholding", () => {
  it("hanya true/false", () => {
    expect(parseBillingForm("setClientWithholding", entries({ clientId: UUID, withholds_pph23: "true" })).success).toBe(true);
    expect(parseBillingForm("setClientWithholding", entries({ clientId: UUID, withholds_pph23: "yes" })).success).toBe(false);
  });
});

describe("izin", () => {
  it("kelola paket & pajak hanya superadmin", () => {
    expect(can(["superadmin"], "billing:manage")).toBe(true);
    expect(can(["ops"], "billing:manage")).toBe(false);
  });
});
