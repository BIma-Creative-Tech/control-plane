/** Klien bebas tagihan (clients.billing_exempt): perpanjangan periode murni tanpa invoice. */
import { describe, expect, it } from "vitest";
import { planExemptRenewal } from "@/lib/billing";

describe("planExemptRenewal", () => {
  const base = { status: "active" as const, endsAt: "2026-12-03", periodMonths: 1 };
  it("dalam periode → null; status lain/data kurang → null", () => {
    expect(planExemptRenewal(base, "2026-12-03")).toBeNull();
    expect(planExemptRenewal({ ...base, status: "suspended" }, "2027-05-01")).toBeNull();
    expect(planExemptRenewal({ ...base, status: "warranty" }, "2027-05-01")).toBeNull();
    expect(planExemptRenewal({ ...base, endsAt: null }, "2027-05-01")).toBeNull();
    expect(planExemptRenewal({ ...base, periodMonths: 0 }, "2027-05-01")).toBeNull();
  });
  it("lewat satu hari → satu periode maju", () => {
    expect(planExemptRenewal(base, "2026-12-04")).toEqual({ from: "active", startsAt: "2026-12-03", endsAt: "2027-01-03" });
  });
  it("tick terlambat berbulan-bulan → digulir sampai mencakup hari ini", () => {
    expect(planExemptRenewal(base, "2027-04-10")).toEqual({ from: "active", startsAt: "2027-04-03", endsAt: "2027-05-03" });
    expect(planExemptRenewal({ ...base, periodMonths: 12 }, "2028-01-01")).toEqual({ from: "active", startsAt: "2027-12-03", endsAt: "2028-12-03" });
  });
  it("past_due dipulihkan walau periode baru belum lewat", () => {
    expect(planExemptRenewal({ ...base, status: "past_due" }, "2026-12-05")).toEqual({ from: "past_due", startsAt: "2026-12-03", endsAt: "2027-01-03" });
  });
});
