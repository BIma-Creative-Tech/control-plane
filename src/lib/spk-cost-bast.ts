/**
 * Biaya produksi & margin per SPK dan status tanda tangan BAST (plan infra 19; `mart.mart_spk` kolom biaya/bast_*,
 * `mart.mart_spk_bast`). Murni, diuji unit.
 *
 * Biaya (data mart): material = MAX(terpakai lewat MO/permintaan barang, PO barang ber-SPK), jasa = MAX(tagihan vendor
 * beranalitik proyek, PO jasa ber-SPK) — PO yang belum terpakai/ditagih dihitung sebagai komitmen biaya tanpa
 * dihitung ganda — tenaga kerja = timesheet (kiosk ½/1 hari × tarif karyawan), lain-lain = baris analitik lain.
 * Margin = nilai SPK tanpa PPN − total biaya.
 */

export type SpkCost = {
  valueUntaxed: number;
  valueTax: number;
  materialUsed: number;
  poGoods: number;
  serviceBilled: number;
  poService: number;
  material: number;
  service: number;
  labor: number;
  other: number;
  total: number;
  laborHours: number;
  /** Jam timesheet bernilai Rp 0 (tarif/biaya per jam karyawan kosong di Odoo) → biaya tenaga kerja kurang. */
  laborHoursUncosted: number;
  margin: number;
  /** null bila nilai SPK 0. */
  marginPct: number | null;
};

const num = (v: unknown) => (v === null || v === undefined || v === "" ? 0 : Number(v));

/**
 * Baris `to_jsonb(mart_spk)` → biaya. null bila data mart belum punya kolom biaya (mart lama, sebelum plan 19).
 */
export function costFromMart(j: Record<string, unknown> | null | undefined): SpkCost | null {
  if (!j || !("cost_total" in j)) return null;
  return {
    valueUntaxed: num(j.value),
    valueTax: num(j.value_tax),
    materialUsed: num(j.material_used),
    poGoods: num(j.po_goods),
    serviceBilled: num(j.service_billed),
    poService: num(j.po_service),
    material: num(j.cost_material),
    service: num(j.cost_service),
    labor: num(j.cost_labor),
    other: num(j.cost_other),
    total: num(j.cost_total),
    laborHours: num(j.labor_hours),
    laborHoursUncosted: num(j.labor_hours_uncosted),
    margin: num(j.margin),
    marginPct: j.margin_pct === null || j.margin_pct === undefined ? null : Number(j.margin_pct),
  };
}

export type Tone = "neutral" | "info" | "warn" | "good" | "danger";

/** Nada margin: rugi = merah, < 20 % = kuning, selain itu hijau; tanpa nilai = netral. */
export function marginTone(pct: number | null): Tone {
  if (pct === null) return "neutral";
  if (pct < 0) return "danger";
  if (pct < 20) return "warn";
  return "good";
}

/** Persen id-ID satu desimal: 78 → "78,0 %"; null → "-". */
export const persen = (pct: number | null) =>
  pct === null ? "-" : `${pct.toLocaleString("id-ID", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} %`;

/** Segmen bar komposisi nilai SPK: biaya per komponen + margin (lebar relatif terhadap max(nilai, biaya)). */
export function costSegments(c: SpkCost): { key: string; label: string; value: number }[] {
  return [
    { key: "material", label: "Material", value: c.material },
    { key: "service", label: "Jasa & sewa", value: c.service },
    { key: "labor", label: "Tenaga kerja", value: c.labor },
    { key: "other", label: "Lain-lain", value: c.other },
    { key: "margin", label: "Margin", value: Math.max(0, c.margin) },
  ].filter((s) => s.value > 0);
}

// ---------------------------------------------------------------- BAST

export type BastDoc = {
  bastId: number;
  bastNo: string;
  kind: string;
  /** custom_bast: draft | signed_one_side | completed | voided */
  state: string;
  location: string | null;
  dateHandover: Date | null;
  partyFrom: string | null;
  partyTo: string | null;
  fromSignedAt: Date | null;
  fromSignedBy: string | null;
  toSignedAt: Date | null;
  toSignedBy: string | null;
  gpsLatitude: number | null;
  gpsLongitude: number | null;
  gpsAccuracy: number | null;
};

export const BAST_KIND_LABEL: Record<string, string> = {
  delivery: "Pengiriman", installation: "Instalasi", handover: "Serah terima", pickup: "Pengambilan",
  return: "Pengembalian",
};

export const BAST_STATE_LABEL: Record<string, string> = {
  draft: "Belum TTD", signed_one_side: "TTD satu pihak", completed: "Lengkap", voided: "Dibatalkan",
};

export function bastStateTone(state: string): Tone {
  return state === "completed" ? "good" : state === "signed_one_side" ? "info" : state === "voided" ? "neutral" : "warn";
}

export type BastCounts = { count: number; completed: number; partial: number };

/** Ringkasan BAST satu SPK (tanpa yang dibatalkan): null bila belum ada BAST. */
export function bastSummary(b: BastCounts): { label: string; tone: Tone } | null {
  if (b.count <= 0) return null;
  if (b.completed >= b.count) return { label: b.count > 1 ? `BAST lengkap ${b.count}/${b.count}` : "BAST lengkap", tone: "good" };
  if (b.completed + b.partial > 0) return { label: `BAST TTD ${b.completed}/${b.count}`, tone: "info" };
  return { label: b.count > 1 ? `BAST belum TTD (${b.count})` : "BAST belum TTD", tone: "warn" };
}

/** Tautan peta untuk koordinat GPS BAST; null bila kosong/0/di luar rentang. */
export function mapsUrl(lat: number | null, lon: number | null): string | null {
  if (lat === null || lon === null || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if ((lat === 0 && lon === 0) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return `https://www.google.com/maps?q=${lat.toFixed(6)},${lon.toFixed(6)}`;
}
