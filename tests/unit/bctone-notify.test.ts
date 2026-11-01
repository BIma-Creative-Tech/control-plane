import { describe, expect, it } from "vitest";
import { composeRegistrationNotice } from "@/bctone/notify";
import { reportPaymentSchema } from "@/billing/portal-payment";

const base = {
  id: "3f2c7a9e-1b4d-4e8a-9c3f-5a6b7c8d9e0f",
  email: "budi@kopi.id",
  ownerName: "Budi",
  businessName: "Kopi Senja",
  slug: "kopi-senja",
  industry: "fnb",
  outlets: 1,
  modules: ["pos", "restaurant"],
  extraNeeds: "integrasi ojol",
  tier: "umkm",
  clientId: null,
  reviewNote: null,
} as never as Parameters<typeof composeRegistrationNotice>[0];
const opts = { ownerEmail: "billing@bimacreative.tech", adminUrl: "https://cp.example", erpHost: "kopi-senja.erp.example" };

describe("notifikasi registrasi", () => {
  it("review → owner, key unik per status, tautan admin, tanpa OTP", () => {
    const n = composeRegistrationNotice({ ...base, status: "review" }, opts)!;
    expect(n.to).toEqual(["billing@bimacreative.tech"]);
    expect(n.key).toBe(`bctone-reg:${base.id}:owner:review`);
    expect(n.text).toContain("https://cp.example/registrations");
    expect(n.text).toContain("Meja & dapur");
    expect(n.key).toMatch(/^[a-z0-9_:./-]{3,200}$/);
  });
  it("done → pendaftar dengan alamat login; rejected → catatan owner; draft → tidak ada", () => {
    const d = composeRegistrationNotice({ ...base, status: "done" }, opts)!;
    expect([d.to, d.key]).toEqual([["budi@kopi.id"], `bctone-reg:${base.id}:welcome`]);
    expect(d.text).toContain("https://kopi-senja.erp.example");
    expect(d.text).not.toMatch(/\n\n\n/);
    const r = composeRegistrationNotice({ ...base, status: "rejected", reviewNote: "kapasitas penuh" }, opts)!;
    expect(r.text).toContain("Catatan: kapasitas penuh");
    expect(composeRegistrationNotice({ ...base, status: "draft" }, opts)).toBeNull();
    expect(composeRegistrationNotice({ ...base, status: "verified" }, opts)).toBeNull();
  });
});

describe("form lapor pembayaran", () => {
  const ok = { invoiceId: base.id, paid_on: "2026-11-01", bank_reference: "BCA 0111 trf INV-1" };
  it("strict, referensi tervalidasi, PPh 23 opsional", () => {
    expect(reportPaymentSchema.parse(ok).bank_reference).toBe("BCA 0111 trf INV-1");
    expect(reportPaymentSchema.safeParse({ ...ok, pph23_reference: "" }).success).toBe(true);
    expect(reportPaymentSchema.safeParse({ ...ok, bank_reference: "<script>" }).success).toBe(false);
    expect(reportPaymentSchema.safeParse({ ...ok, paid_on: "2026-13-01" }).success).toBe(false);
    expect(reportPaymentSchema.safeParse({ ...ok, clientId: base.id }).success).toBe(false);
  });
});
