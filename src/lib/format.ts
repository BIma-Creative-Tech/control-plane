/** Format tampilan dashboard (id-ID, WIB). Murni, diuji unit. */
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
  Desain: "bg-slate-200 text-slate-800",
  Produksi: "bg-blue-100 text-blue-800",
  Instalasi: "bg-cyan-100 text-cyan-800",
  Laporan: "bg-amber-100 text-amber-800",
  BAST: "bg-emerald-100 text-emerald-800",
  Selesai: "bg-emerald-200 text-emerald-900",
};
export const stageTone = (stage: string) => STAGE_TONE[stage] ?? "bg-slate-100 text-slate-700";

export const ACTIVITY_LABEL: Record<string, string> = {
  loading: "Loading (pasang)", unloading: "Unloading (bongkar)", installment: "Instalasi", maintenance: "Maintenance",
  cleaning: "General Cleaning", takeout: "Takeout", production: "Produksi workshop", other: "Lainnya",
};
