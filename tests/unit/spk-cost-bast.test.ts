import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import {
  bastStateTone, bastSummary, costFromMart, costSegments, mapsUrl, marginTone, persen,
} from "@/lib/spk-cost-bast";
import { MART_SPK } from "@/server/mart-spk";

// Baris mart_spk SPK/2026/10/02-001751 (staging, 2026-10-02) — numeric dari pg/to_jsonb bisa string atau number.
const mart = {
  value: "8500000.00", value_tax: 935000, material_used: "368350.00", po_goods: 0, service_billed: "1500000.00",
  po_service: "1500000.00", cost_material: "368350.00", cost_service: "1500000.00", cost_labor: "0.00", cost_other: 0,
  cost_total: "1868350.00", labor_hours: 8, labor_hours_uncosted: 8, margin: "6631650.00", margin_pct: "78.0",
};

describe("biaya produksi & margin (plan 19)", () => {
  it("baris mart → angka; mart lama tanpa kolom biaya → null", () => {
    const c = costFromMart(mart)!;
    expect(c).toMatchObject({ valueUntaxed: 8_500_000, valueTax: 935_000, material: 368_350, service: 1_500_000,
      labor: 0, total: 1_868_350, laborHoursUncosted: 8, margin: 6_631_650, marginPct: 78 });
    expect(costFromMart({ value: 1 })).toBeNull();
    expect(costFromMart(null)).toBeNull();
    expect(costFromMart({ ...mart, margin_pct: null })!.marginPct).toBeNull();
  });

  it("nada margin: rugi merah, tipis kuning, sehat hijau, tanpa nilai netral", () => {
    expect(marginTone(-5)).toBe("danger");
    expect(marginTone(0)).toBe("warn");
    expect(marginTone(19.9)).toBe("warn");
    expect(marginTone(20)).toBe("good");
    expect(marginTone(null)).toBe("neutral");
  });

  it("persen id-ID", () => {
    expect(persen(78)).toBe("78,0 %");
    expect(persen(-3.25)).toMatch(/^-3,[23] %$/);
    expect(persen(null)).toBe("-");
  });

  it("segmen bar: komponen > 0 + margin (rugi → tanpa segmen margin)", () => {
    const c = costFromMart(mart)!;
    expect(costSegments(c).map((s) => s.key)).toEqual(["material", "service", "margin"]);
    expect(costSegments({ ...c, margin: -10 }).map((s) => s.key)).toEqual(["material", "service"]);
  });
});

describe("status BAST (plan 19)", () => {
  it("ringkasan per SPK", () => {
    expect(bastSummary({ count: 0, completed: 0, partial: 0 })).toBeNull();
    expect(bastSummary({ count: 1, completed: 0, partial: 0 })).toEqual({ label: "BAST belum TTD", tone: "warn" });
    expect(bastSummary({ count: 3, completed: 0, partial: 0 })?.label).toBe("BAST belum TTD (3)");
    expect(bastSummary({ count: 2, completed: 1, partial: 0 })).toEqual({ label: "BAST TTD 1/2", tone: "info" });
    expect(bastSummary({ count: 2, completed: 0, partial: 1 })?.label).toBe("BAST TTD 0/2");
    expect(bastSummary({ count: 1, completed: 1, partial: 0 })).toEqual({ label: "BAST lengkap", tone: "good" });
    expect(bastSummary({ count: 2, completed: 2, partial: 0 })?.label).toBe("BAST lengkap 2/2");
  });

  it("nada status dokumen", () => {
    expect(bastStateTone("completed")).toBe("good");
    expect(bastStateTone("signed_one_side")).toBe("info");
    expect(bastStateTone("draft")).toBe("warn");
    expect(bastStateTone("voided")).toBe("neutral");
  });

  it("tautan peta hanya untuk koordinat valid", () => {
    expect(mapsUrl(-6.2, 106.816666)).toBe("https://www.google.com/maps?q=-6.200000,106.816666");
    expect(mapsUrl(null, 106)).toBeNull();
    expect(mapsUrl(0, 0)).toBeNull();
    expect(mapsUrl(91, 10)).toBeNull();
    expect(mapsUrl(Number.NaN, 10)).toBeNull();
  });

  it("MART_SPK membaca kolom plan 19 lewat to_jsonb (mart lama tetap jalan)", () => {
    expect(MART_SPK).toContain("to_jsonb(m) ->> 'bast_count'");
    expect(MART_SPK).toContain("to_jsonb(m) ->> 'margin'");
    expect(MART_SPK).not.toMatch(/m\.bast_count|m\.margin/);
  });
});
