import { describe, expect, it } from "vitest";
import { docHref, groupProcurement, isDocKind, procurementStatus, type ScmDoc, type VendorPayment } from "@/lib/scm";

const doc = (kind: string, docId: number, poId: number | null, extra: Partial<ScmDoc> = {}): ScmDoc => ({
  kind, docId, docNo: `${kind.toUpperCase()}-${docId}`, state: "done", date: new Date(2026, 8, docId % 28 + 1), party: "Vendor",
  detail: null, poId, ...extra,
});
const pay = (paymentId: number, billId: number, poId: number, amount: number): VendorPayment => ({
  poId, billId, billNo: `BILL-${billId}`, paymentId, paymentNo: `PAY-${paymentId}`, state: "paid", date: null, journal: "Bank",
  memo: null, amount,
});

describe("groupProcurement", () => {
  it("satu baris per PO berisi GR, tagihan, pembayaran milik PO itu; MO & surat jalan terpisah", () => {
    const scm = [
      doc("po", 1, 1, { state: "purchase", detail: "full" }), doc("po", 2, 2, { state: "purchase", detail: null }),
      doc("receipt", 10, 1), doc("receipt", 11, 1, { state: "assigned" }),
      doc("bill", 20, 1, { state: "posted", detail: "paid" }), doc("bill", 21, 2, { state: "posted", detail: "not_paid" }),
      doc("mo", 30, null), doc("delivery", 40, null),
    ];
    const g = groupProcurement(scm, [pay(50, 20, 1, 100), pay(50, 20, 1, 50)]);
    expect(g.rows.map((r) => r.po?.docId)).toEqual([1, 2]);
    expect(g.rows[0]?.receipts.map((r) => r.docId)).toEqual([10, 11]);
    expect(g.rows[0]?.bills.map((r) => r.docId)).toEqual([20]);
    expect(g.rows[0]?.payments).toHaveLength(2);
    expect(g.rows[1]?.receipts).toEqual([]);
    expect(g.rows[1]?.payments).toEqual([]);
    expect(g.mos.map((m) => m.docId)).toEqual([30]);
    expect(g.deliveries.map((m) => m.docId)).toEqual([40]);
  });

  it("GR/tagihan tanpa PO yang dikenal → baris 'tanpa PO' (tidak hilang)", () => {
    const g = groupProcurement([doc("receipt", 10, null), doc("bill", 20, 99, { state: "posted", detail: "not_paid" })]);
    expect(g.rows).toHaveLength(1);
    expect(g.rows[0]?.po).toBeNull();
    expect(g.rows[0]?.receipts).toHaveLength(1);
    expect(g.rows[0]?.bills).toHaveLength(1);
  });
});

describe("procurementStatus", () => {
  const po = doc("po", 1, 1, { state: "purchase", detail: "pending" });
  it("urutan tahap: bayar > tagih > terima > pesan", () => {
    expect(procurementStatus(po, [], []).label).toBe("Dipesan, menunggu barang");
    expect(procurementStatus({ ...po, detail: null }, [], []).label).toBe("Dipesan (jasa)");
    expect(procurementStatus({ ...po, state: "draft" }, [], []).label).toBe("RFQ (belum dipesan)");
    expect(procurementStatus(po, [doc("receipt", 2, 1, { state: "assigned" })], []).label).toBe("Menunggu barang");
    expect(procurementStatus(po, [doc("receipt", 2, 1), doc("receipt", 3, 1, { state: "assigned" })], []).label).toBe("Diterima sebagian");
    expect(procurementStatus(po, [doc("receipt", 2, 1)], []).label).toBe("Barang diterima");
    const bill = (detail: string) => doc("bill", 5, 1, { state: "posted", detail });
    expect(procurementStatus(po, [], [bill("not_paid")])).toEqual({ label: "Ditagih vendor, belum dibayar", tone: "warn" });
    expect(procurementStatus(po, [], [bill("partial")]).label).toBe("Dibayar sebagian");
    expect(procurementStatus(po, [], [bill("paid"), bill("in_payment")])).toEqual({ label: "Lunas dibayar ke vendor", tone: "good" });
    expect(procurementStatus(po, [], [bill("paid"), { ...bill("not_paid"), docId: 6 }]).label).toBe("Dibayar sebagian");
    expect(procurementStatus(po, [], [doc("bill", 5, 1, { state: "draft" })]).label).toBe("Tagihan vendor draft");
  });

  it("tagihan yang di-reverse diabaikan → tahap sebelumnya", () => {
    const reversed = doc("bill", 5, 1, { state: "posted", detail: "reversed" });
    expect(procurementStatus(po, [doc("receipt", 2, 1)], [reversed]).label).toBe("Barang diterima");
  });
});

describe("docHref / isDocKind", () => {
  it("tautan detail dokumen di bawah detail SPK", () => {
    expect(docHref("expomedia", 2215, "po", 2645)).toBe("/dashboard/spk/2215/dokumen/po/2645?client=expomedia");
    expect(isDocKind("payment")).toBe(true);
    expect(isDocKind("sale")).toBe(false);
  });
});
