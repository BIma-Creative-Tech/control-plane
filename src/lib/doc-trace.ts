/**
 * Isu link dokumen (plan infra 18, modul Odoo `custom_doc_trace` → mart.mart_spk_issue): label Indonesia, urutan &
 * tautan ke dokumen di Odoo. Murni, diuji unit.
 */

export type DocTraceIssue = {
  issueId: number;
  ruleCode: string;
  severity: string;
  resModel: string;
  resId: number;
  docNo: string | null;
  /** 'open' = perlu tindakan; 'auto_fixed' = sudah diperbaiki otomatis (30 hari terakhir). */
  state: string;
  message: string | null;
  firstSeen: Date | null;
  lastSeen: Date | null;
  fixedAt: Date | null;
};

/** Nama aturan (kode dari custom_doc_trace); kode baru yang belum dikenal → pesan isu dari Odoo / kodenya. */
export const RULE_LABEL: Record<string, string> = {
  ZERO_BILL: "Tagihan vendor Rp 0 / ganda",
  PO_NO_PROJECT: "PO tanpa proyek SPK",
  PO_ORPHAN: "PO tidak tertaut SPK",
  PO_RECREATED: "PO dibuat ulang tanpa link",
  PROJECT_QUOTE_NAME: "Nama proyek masih nomor penawaran",
  MO_NO_PROJECT: "Produksi (MO) tanpa proyek SPK",
  PICKING_NO_PROJECT: "Pengiriman/penerimaan tanpa proyek SPK",
  BILL_NO_PO_LINK: "Tagihan vendor tidak tertaut baris PO",
  INV_NO_SO_LINK: "Invoice tidak tertaut baris SPK",
  ACTIVE_UNDER_CANCELLED_SO: "Dokumen aktif di bawah SPK batal",
  COPIED_UNLINKED: "Hasil duplikasi tanpa link",
  PAYMENT_UNRECONCILED: "Pembayaran belum direkonsiliasi",
  TIMESHEET_CANCELLED_SO: "Timesheet di SPK batal",
};

export const MODEL_LABEL: Record<string, string> = {
  "sale.order": "SPK",
  "purchase.order": "PO",
  "stock.picking": "Transfer stok",
  "mrp.production": "MO",
  "account.move": "Invoice/tagihan",
  "account.payment": "Pembayaran",
  "project.project": "Proyek",
  "project.task": "Task",
};

export const ISSUE_STATE_LABEL: Record<string, string> = { open: "Perlu tindakan", auto_fixed: "Diperbaiki otomatis" };

export type IssueTone = "neutral" | "info" | "warn" | "good" | "danger";

export function issueTone(i: Pick<DocTraceIssue, "state" | "severity">): IssueTone {
  if (i.state === "auto_fixed") return "good";
  return i.severity === "error" ? "danger" : i.severity === "warn" ? "warn" : "info";
}

export const ruleLabel = (i: Pick<DocTraceIssue, "ruleCode" | "message">) =>
  RULE_LABEL[i.ruleCode] ?? i.message ?? i.ruleCode;

const SEVERITY_RANK: Record<string, number> = { error: 0, warn: 1, info: 2 };

/** Terbuka dulu (error → warn → info), lalu yang terbaru; diperbaiki otomatis di akhir. */
export function sortIssues<T extends Pick<DocTraceIssue, "state" | "severity" | "lastSeen" | "issueId">>(issues: T[]): T[] {
  const t = (d: Date | null) => d?.getTime() ?? 0;
  return [...issues].sort((a, b) =>
    Number(a.state !== "open") - Number(b.state !== "open")
    || (SEVERITY_RANK[a.severity] ?? 3) - (SEVERITY_RANK[b.severity] ?? 3)
    || t(b.lastSeen) - t(a.lastSeen)
    || b.issueId - a.issueId);
}

/** Path rekaman Odoo 17+ (`/odoo/<model>/<id>`); null bila model/id tidak valid. */
export function odooRecordPath(model: string, id: number): string | null {
  if (!/^[a-z_]+(\.[a-z_]+)+$/.test(model) || !Number.isInteger(id) || id <= 0) return null;
  return `/odoo/${model}/${id}`;
}
