/** Format tampilan dashboard (id-ID, WIB). Murni, diuji unit. Kelas tone dipakai <Badge> (ring-1 ring-inset). */
const RUPIAH = new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 });
const COMPACT = new Intl.NumberFormat("id-ID", { notation: "compact", maximumFractionDigits: 1 });
const DATE = new Intl.DateTimeFormat("id-ID", { day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Jakarta" });
const DATETIME = new Intl.DateTimeFormat("id-ID", {
  day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Jakarta",
});

export const rupiah = (v: number | undefined) => RUPIAH.format(v ?? 0);
export const rupiahCompact = (v: number | undefined) => `Rp ${COMPACT.format(v ?? 0)}`;
export const tanggal = (d: Date | string | null | undefined) => (d ? DATE.format(new Date(d)) : "-");
export const tanggalJam = (d: Date | string | null | undefined) => (d ? DATETIME.format(new Date(d)) : "-");

const STAGE_TONE: Record<string, string> = {
  Desain: "bg-stone-500/15 text-stone-800 ring-stone-600/25 dark:text-stone-200 dark:ring-stone-400/30",
  Produksi: "bg-blue-500/10 text-blue-800 ring-blue-600/25 dark:text-blue-300 dark:ring-blue-400/30",
  Instalasi: "bg-cyan-500/10 text-cyan-800 ring-cyan-600/25 dark:text-cyan-300 dark:ring-cyan-400/30",
  Laporan: "bg-amber-500/12 text-amber-800 ring-amber-600/25 dark:text-amber-300 dark:ring-amber-400/30",
  BAST: "bg-emerald-500/10 text-emerald-800 ring-emerald-600/25 dark:text-emerald-300 dark:ring-emerald-400/30",
  Selesai: "bg-emerald-600 text-white ring-emerald-700/40 dark:bg-emerald-500/25 dark:text-emerald-200 dark:ring-emerald-400/40",
};
export const stageTone = (stage: string) => STAGE_TONE[stage] ?? "bg-slate-500/10 text-slate-700 ring-slate-500/25 dark:text-slate-300 dark:ring-slate-400/30";

export const ACTIVITY_LABEL: Record<string, string> = {
  loading: "Loading (pasang)", unloading: "Unloading (bongkar)", installment: "Instalasi", maintenance: "Maintenance",
  cleaning: "General Cleaning", takeout: "Takeout", production: "Produksi workshop", other: "Lainnya",
};

/** Quotation Tracker (plan infra 15): label & warna tahap `mart_spk.tracker_stage`. */
export const TRACK_LABEL: Record<string, string> = {
  penawaran: "Penawaran dibuat", terkirim: "Penawaran terkirim", spk: "SPK", produksi: "Produksi", ditagih: "Ditagih", lunas: "Lunas", batal: "Batal",
};
const TRACK_TONE: Record<string, string> = {
  penawaran: "bg-stone-500/15 text-stone-800 ring-stone-600/25 dark:text-stone-200 dark:ring-stone-400/30",
  terkirim: "bg-sky-500/10 text-sky-800 ring-sky-600/25 dark:text-sky-300 dark:ring-sky-400/30",
  spk: "bg-indigo-500/10 text-indigo-800 ring-indigo-600/25 dark:text-indigo-300 dark:ring-indigo-400/30",
  produksi: "bg-blue-500/10 text-blue-800 ring-blue-600/25 dark:text-blue-300 dark:ring-blue-400/30",
  ditagih: "bg-amber-500/12 text-amber-800 ring-amber-600/25 dark:text-amber-300 dark:ring-amber-400/30",
  lunas: "bg-emerald-500/10 text-emerald-800 ring-emerald-600/25 dark:text-emerald-300 dark:ring-emerald-400/30",
  batal: "bg-rose-500/10 text-rose-800 ring-rose-600/25 dark:text-rose-300 dark:ring-rose-400/30",
};
export const trackTone = (track: string) => TRACK_TONE[track] ?? "bg-slate-500/10 text-slate-700 ring-slate-500/25 dark:text-slate-300 dark:ring-slate-400/30";

/** account.move.payment_state (Odoo 19). */
export const PAYMENT_STATE_LABEL: Record<string, string> = {
  not_paid: "Belum dibayar", in_payment: "Dalam proses", paid: "Lunas", partial: "Sebagian",
  reversed: "Dibatalkan (refund)", blocked: "Ditahan", invoicing_legacy: "Legacy",
};

/** Dokumen supply chain per SPK (plan infra 16, `mart_spk_scm.kind`). */
export const SCM_KIND_LABEL: Record<string, string> = {
  po: "Purchase Order", receipt: "Penerimaan material", mo: "Perintah produksi", delivery: "Surat jalan",
  bill: "Tagihan vendor",
};
/** State Odoo 19 purchase.order / stock.picking / mrp.production / account.move → label Indonesia. */
export const SCM_STATE_LABEL: Record<string, string> = {
  draft: "Draft", sent: "RFQ terkirim", "to approve": "Menunggu persetujuan", purchase: "Dipesan", done: "Selesai",
  cancel: "Batal", waiting: "Menunggu", confirmed: "Dikonfirmasi", assigned: "Siap", progress: "Berjalan",
  to_close: "Siap ditutup", posted: "Diposting",
};
export const scmTone = (state: string) =>
  state === "done" || state === "posted" ? "bg-emerald-500/10 text-emerald-800 ring-emerald-600/25 dark:text-emerald-300 dark:ring-emerald-400/30"
  : state === "cancel" ? "bg-rose-500/10 text-rose-800 ring-rose-600/25 dark:text-rose-300 dark:ring-rose-400/30"
  : state === "draft" || state === "sent" ? "bg-slate-500/10 text-slate-700 ring-slate-500/25 dark:text-slate-300 dark:ring-slate-400/30"
  : "bg-blue-500/10 text-blue-800 ring-blue-600/25 dark:text-blue-300 dark:ring-blue-400/30";
