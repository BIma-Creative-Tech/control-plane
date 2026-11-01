/**
 * ADR 0019 (BCTOne) — siklus langganan self_serve: past_due J+0, suspend J+7 (kecuali bukti bayar menunggu konfirmasi),
 * penanda purge 14 hari setelah suspend. Siklus `implementation` (ADR 0018) tidak boleh berubah.
 */
import { describe, expect, it } from "vitest";
import { SELF_SERVE_GRACE_DAYS, SELF_SERVE_RETENTION_DAYS, planTransitions, type SubscriptionSnapshot } from "@/lib/billing";

const ss = (o: Partial<SubscriptionSnapshot>): SubscriptionSnapshot => ({
  status: "active",
  warrantyUntil: null,
  startsAt: "2026-11-01",
  endsAt: "2026-12-01",
  graceUntil: null,
  periodMonths: 1,
  lifecycle: "self_serve",
  suspendedOn: null,
  purgeDueOn: null,
  hasPendingProof: false,
  ...o,
});

describe("planTransitions — self_serve (ADR 0019)", () => {
  it("konstanta sesuai keputusan owner", () => {
    expect(SELF_SERVE_GRACE_DAYS).toBe(7);
    expect(SELF_SERVE_RETENTION_DAYS).toBe(14);
  });

  it("active tetap sampai hari ends_at (inklusif), lalu past_due dengan grace 7 hari", () => {
    expect(planTransitions(ss({}), "2026-12-01").transitions).toEqual([]);
    const p = planTransitions(ss({}), "2026-12-02");
    expect(p.transitions).toEqual([{ from: "active", to: "past_due", graceUntil: "2026-12-08" }]);
    expect(p.final.status).toBe("past_due");
  });

  it("past_due → suspended setelah grace_until", () => {
    const s = ss({ status: "past_due", graceUntil: "2026-12-08" });
    expect(planTransitions(s, "2026-12-08").transitions).toEqual([]);
    const p = planTransitions(s, "2026-12-09");
    expect(p.transitions).toEqual([{ from: "past_due", to: "suspended", enqueueSuspend: true }]);
    expect(p.final.suspendedOn).toBe("2026-12-09");
  });

  it("BR-18: bukti bayar menunggu konfirmasi menahan suspend", () => {
    const p = planTransitions(ss({ status: "past_due", graceUntil: "2026-12-08", hasPendingProof: true }), "2026-12-20");
    expect(p.transitions).toEqual([]);
    expect(p.final.status).toBe("past_due");
  });

  it("suspended → purge_due setelah 14 hari, hanya sekali", () => {
    const s = ss({ status: "suspended", suspendedOn: "2026-12-09" });
    expect(planTransitions(s, "2026-12-23").transitions).toEqual([]);
    const p = planTransitions(s, "2026-12-24");
    expect(p.transitions).toEqual([{ from: "suspended", to: "purge_due", purgeDueOn: "2026-12-23" }]);
    expect(planTransitions(ss({ status: "suspended", suspendedOn: "2026-12-09", purgeDueOn: "2026-12-23" }), "2027-01-30").transitions).toEqual([]);
  });

  it("tick terlambat: active → past_due → suspended dalam satu tick, purge belum (dihitung dari suspend nyata)", () => {
    const p = planTransitions(ss({}), "2027-01-15");
    expect(p.transitions.map((t) => t.to)).toEqual(["past_due", "suspended"]);
    expect(p.final.suspendedOn).toBe("2027-01-15");
    expect(p.final.purgeDueOn).toBeNull();
  });

  it("suspended tanpa tanggal = anomali, tanpa transisi", () => {
    const p = planTransitions(ss({ status: "suspended", suspendedOn: null }), "2027-01-15");
    expect(p.anomaly).toBe("suspended_without_date");
    expect(p.transitions).toEqual([]);
  });

  it("self_serve tidak memakai warranty/implementation", () => {
    expect(planTransitions(ss({ status: "implementation" }), "2030-01-01").transitions).toEqual([]);
    expect(planTransitions(ss({ status: "warranty", warrantyUntil: "2026-01-01" }), "2030-01-01").transitions).toEqual([]);
  });

  it("regresi: tanpa lifecycle = implementation (grace 2 bulan ADR 0018, suspended tidak pernah purge)", () => {
    const legacy: SubscriptionSnapshot = { status: "active", warrantyUntil: null, startsAt: "2026-11-01", endsAt: "2026-12-01", graceUntil: null, periodMonths: 1 };
    expect(planTransitions(legacy, "2026-12-02").transitions).toEqual([{ from: "active", to: "past_due", graceUntil: "2027-02-01" }]);
    const susp: SubscriptionSnapshot = { ...legacy, status: "suspended", lifecycle: "implementation", suspendedOn: "2026-01-01" };
    expect(planTransitions(susp, "2030-01-01").transitions).toEqual([]);
  });
});
