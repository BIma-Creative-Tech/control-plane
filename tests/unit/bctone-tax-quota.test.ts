/** ADR 0019 — pajak (BR-16/17) & kuota (BR-08..12) BCTOne. Angka contoh = docs/BCTONE_FINAL_v2.md. */
import { describe, expect, it } from "vitest";
import { computeInvoiceTax } from "@/lib/bctone-tax";
import { BCTONE_PLAN_QUOTAS, QUOTA_METRICS, canConsumeQuota, isQuotaMetric, quotaHardStop, quotaState } from "@/lib/bctone-quota";

describe("computeInvoiceTax", () => {
  it("UMKM Rp199.000 → PPN 21.890, total 220.890", () => {
    expect(computeInvoiceTax("199000", { scheme: "ppn_dpp_nilai_lain", withholdPph23: false })).toEqual({
      scheme: "ppn_dpp_nilai_lain",
      amount: "199000.00",
      ppnAmount: "21890.00",
      pph23Amount: "0.00",
      totalAmount: "220890.00",
      payableAmount: "220890.00",
    });
  });

  it("PPh 23 → transfer 216.910", () => {
    const t = computeInvoiceTax("199000.00", { scheme: "ppn_dpp_nilai_lain", withholdPph23: true });
    expect(t.pph23Amount).toBe("3980.00");
    expect(t.payableAmount).toBe("216910.00");
  });

  it("bulat ke bawah ke rupiah penuh", () => {
    expect(computeInvoiceTax("35001", { scheme: "ppn_dpp_nilai_lain", withholdPph23: false }).ppnAmount).toBe("3850.00");
  });

  it("scheme none = tanpa PPN (invoice implementasi lama)", () => {
    const t = computeInvoiceTax("1500000.50", { scheme: "none", withholdPph23: false });
    expect(t.ppnAmount).toBe("0.00");
    expect(t.totalAmount).toBe("1500000.50");
  });

  it("nominal maksimum 12 digit tanpa overflow", () => {
    expect(computeInvoiceTax("999999999999.99", { scheme: "ppn_dpp_nilai_lain", withholdPph23: true }).ppnAmount).toBe("109999999999.00");
  });

  it("menolak nominal tidak valid", () => {
    expect(() => computeInvoiceTax("-1", { scheme: "none", withholdPph23: false })).toThrow(RangeError);
    expect(() => computeInvoiceTax("1.234", { scheme: "none", withholdPph23: false })).toThrow(RangeError);
  });
});

describe("kuota BCTOne", () => {
  const free = BCTONE_PLAN_QUOTAS["bctone-free"]!;

  it("seed Free sesuai K-19", () => {
    expect(free).toEqual({ users: 1, devices: 1, outlets: 1, trx_per_month: 300, omzet_per_month: 25_000_000, ai_prompts_per_day: 3 });
    for (const q of Object.values(BCTONE_PLAN_QUOTAS)) expect(Object.keys(q).sort()).toEqual([...QUOTA_METRICS].sort());
  });

  it("transaksi: warn 240, grace 301..330, blocked 331", () => {
    expect(quotaState("trx_per_month", 300, 239)).toBe("ok");
    expect(quotaState("trx_per_month", 300, 240)).toBe("warn");
    expect(quotaState("trx_per_month", 300, 330)).toBe("grace");
    expect(quotaState("trx_per_month", 300, 331)).toBe("blocked");
    expect(canConsumeQuota("trx_per_month", 300, 329)).toBe(true);
    expect(canConsumeQuota("trx_per_month", 300, 330)).toBe(false);
  });

  it("omzet hard stop 27,5 jt", () => {
    expect(quotaHardStop("omzet_per_month", 25_000_000)).toBe(27_500_000);
  });

  it("AI tanpa grace: prompt ke-4 ditolak; null = tanpa batas", () => {
    expect(canConsumeQuota("ai_prompts_per_day", 3, 3)).toBe(false);
    expect(canConsumeQuota("omzet_per_month", null, 1e12)).toBe(true);
  });

  it("validasi metrik & pemakaian", () => {
    expect(isQuotaMetric("users")).toBe(true);
    expect(isQuotaMetric("drop table")).toBe(false);
    expect(() => quotaState("users", 1, -1)).toThrow(RangeError);
  });
});
