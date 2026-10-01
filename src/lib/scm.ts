/**
 * Pengelompokan dokumen supply chain SPK per PO (detail SPK, 2026-10-01): satu baris = satu PO beserta penerimaan
 * (GR), tagihan vendor, dan pembayaran ke vendor; MO & surat jalan terpisah (milik SPK, bukan PO). Murni, diuji unit.
 */

export type ScmKind = "po" | "receipt" | "bill" | "mo" | "delivery";

export type ScmDoc = {
  kind: string;
  docId: number;
  docNo: string;
  state: string;
  date: Date | null;
  party: string | null;
  /** po: receipt_status · receipt/delivery: origin · mo: qty · bill: payment_state. */
  detail: string | null;
  /** PO induk (po/receipt/bill); null untuk MO, surat jalan, atau penerimaan tanpa PO. */
  poId: number | null;
  amount?: number | null;
  amountPaid?: number | null;
};

export type VendorPayment = {
  poId: number;
  billId: number;
  billNo: string;
  paymentId: number;
  paymentNo: string | null;
  state: string;
  date: Date | null;
  journal: string | null;
  memo: string | null;
  /** Alokasi pembayaran ke tagihan ini. */
  amount: number;
};

export type Tone = "neutral" | "info" | "warn" | "good" | "danger";
export type ProcurementStatus = { label: string; tone: Tone };

export type ProcurementRow = {
  /** null = penerimaan/tagihan yang tidak tertaut ke PO mana pun. */
  po: ScmDoc | null;
  receipts: ScmDoc[];
  bills: ScmDoc[];
  /** Unik per (pembayaran, tagihan) milik PO ini. */
  payments: VendorPayment[];
  status: ProcurementStatus;
};

const PAID = new Set(["paid", "in_payment"]);

/** Status terakhir satu PO: tahap paling lanjut yang sudah tercapai (bayar → tagih → terima → pesan). */
export function procurementStatus(po: ScmDoc | null, receipts: ScmDoc[], bills: ScmDoc[]): ProcurementStatus {
  // Tagihan yang di-reverse (dibatalkan lewat refund) diabaikan → status jatuh ke tahap sebelumnya.
  const active = bills.filter((b) => b.detail !== "reversed");
  const posted = active.filter((b) => b.state === "posted");
  if (posted.length) {
    const states = posted.map((b) => b.detail ?? "not_paid");
    if (states.every((s) => PAID.has(s))) return { label: "Lunas dibayar ke vendor", tone: "good" };
    if (states.some((s) => s === "partial" || PAID.has(s))) return { label: "Dibayar sebagian", tone: "warn" };
    return { label: "Ditagih vendor, belum dibayar", tone: "warn" };
  }
  if (active.length) return { label: "Tagihan vendor draft", tone: "neutral" };
  if (receipts.length) {
    const done = receipts.filter((r) => r.state === "done").length;
    if (done === receipts.length) return { label: "Barang diterima", tone: "info" };
    if (done > 0 || po?.detail === "partial") return { label: "Diterima sebagian", tone: "info" };
    return { label: "Menunggu barang", tone: "neutral" };
  }
  if (!po) return { label: "-", tone: "neutral" };
  if (po.state === "draft" || po.state === "sent") return { label: "RFQ (belum dipesan)", tone: "neutral" };
  if (po.state === "to approve") return { label: "Menunggu persetujuan", tone: "neutral" };
  if (po.state === "done") return { label: "PO dikunci", tone: "neutral" };
  return { label: po.detail ? "Dipesan, menunggu barang" : "Dipesan (jasa)", tone: "info" };
}

const byDate = (a: ScmDoc, b: ScmDoc) => (a.date?.getTime() ?? 0) - (b.date?.getTime() ?? 0) || a.docId - b.docId;

export function groupProcurement(scm: ScmDoc[], payments: VendorPayment[] = []) {
  const pos = scm.filter((d) => d.kind === "po").sort(byDate);
  const rows: ProcurementRow[] = pos.map((po) => {
    const receipts = scm.filter((d) => d.kind === "receipt" && d.poId === po.docId).sort(byDate);
    const bills = scm.filter((d) => d.kind === "bill" && d.poId === po.docId).sort(byDate);
    const pays = payments.filter((p) => p.poId === po.docId);
    return { po, receipts, bills, payments: pays, status: procurementStatus(po, receipts, bills) };
  });
  const known = new Set(pos.map((p) => p.docId));
  const orphanReceipts = scm.filter((d) => d.kind === "receipt" && (d.poId === null || !known.has(d.poId))).sort(byDate);
  const orphanBills = scm.filter((d) => d.kind === "bill" && (d.poId === null || !known.has(d.poId))).sort(byDate);
  if (orphanReceipts.length || orphanBills.length) {
    const billIds = new Set(orphanBills.map((b) => b.docId));
    rows.push({
      po: null, receipts: orphanReceipts, bills: orphanBills,
      payments: payments.filter((p) => billIds.has(p.billId) && !known.has(p.poId)),
      status: procurementStatus(null, orphanReceipts, orphanBills),
    });
  }
  return {
    rows,
    mos: scm.filter((d) => d.kind === "mo").sort(byDate),
    deliveries: scm.filter((d) => d.kind === "delivery").sort(byDate),
  };
}

/** Tautan halaman detail dokumen (di dalam detail SPK). */
export const docHref = (client: string, soId: number, kind: ScmKind | "payment", docId: number) =>
  `/dashboard/spk/${soId}/dokumen/${kind}/${docId}?client=${encodeURIComponent(client)}`;

export const DOC_KINDS = ["po", "receipt", "bill", "mo", "delivery", "payment"] as const;
export type DocKind = (typeof DOC_KINDS)[number];
export const isDocKind = (k: string): k is DocKind => (DOC_KINDS as readonly string[]).includes(k);
