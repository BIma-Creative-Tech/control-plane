import "server-only";
import { withMart } from "@/db/datamart";
import type { TrackStage, TrackerParams } from "@/lib/spk-params";
import { aeOnly, type ClientAccess } from "@/server/spk-dashboard";

/**
 * Quotation Tracker (plan infra 15): satu baris per Penawaran/SPK dari `mart.mart_spk` dengan tahap terjauh
 * (`tracker_stage`) Penawaran → SPK → Produksi → Ditagih → Lunas, plus ringkasan absensi kru (timesheet),
 * penagihan dan pembayaran. Aturan akses sama dengan dashboard SPK: kolom Rp hanya DIPILIH bila `canSeeValue`,
 * AE murni hanya melihat miliknya, isolasi client = RLS.
 */

const FILTER = `
  env = $1
  AND ($2::text = '' OR spk_no ILIKE '%' || $2 || '%' OR quotation_name ILIKE '%' || $2 || '%'
       OR legacy_ref ILIKE '%' || $2 || '%' OR customer ILIKE '%' || $2 || '%' OR brand ILIKE '%' || $2 || '%'
       OR ae ILIKE '%' || $2 || '%')
  AND ($3::text = '' OR ae_login = $3)`;
const TRACK_FILTER = `AND (($4::text = '' AND tracker_stage <> 'batal') OR tracker_stage = $4)`;

const ORDER_BY: Record<TrackerParams["sort"], string> = {
  date_desc: "date_order DESC NULLS LAST, so_id DESC",
  date_asc: "date_order ASC NULLS LAST, so_id ASC",
  stage_asc: "array_position(ARRAY['penawaran','spk','produksi','ditagih','lunas','batal'], tracker_stage), date_order DESC NULLS LAST",
  last_desc: "last_status_at DESC NULLS LAST, so_id DESC",
  value_desc: "value DESC NULLS LAST, so_id DESC",
};

export type TrackerRow = {
  soId: number;
  spkNo: string;
  quotationName: string | null;
  track: TrackStage;
  dateOrder: Date | null;
  customer: string | null;
  brand: string | null;
  ae: string | null;
  locations: number;
  stage: string;
  progress: number;
  crewHours: number;
  crewPeople: number;
  invoiceCount: number;
  nextDueDate: Date | null;
  paymentCount: number;
  lastPaymentDate: Date | null;
  value?: number;
  invoiced?: number;
  paid?: number;
  due?: number;
  overdue?: number;
  isMockup?: boolean;
};

/** Langkah funnel: `reached` = jumlah yang sudah melewati/berada di langkah ini, `current` = berhenti di sini. */
export type FunnelStep = { key: string; label: string; reached: number; current: number; amount?: number };

export type QuotationTracker = {
  rows: TrackerRow[];
  total: number;
  refreshedAt: Date | null;
  funnel: FunnelStep[];
  cancelled: number;
  crewHours: number;
  value?: { quoted: number; spk: number; invoiced: number; paid: number; due: number; overdue: number; isMockup: boolean };
};

const BASE_COLS = `so_id, spk_no, quotation_name, tracker_stage, date_order, customer, brand, ae, locations, stage,
  progress_pct, crew_hours, crew_people, invoice_count, next_due_date, payment_count, last_payment_date`;
const VALUE_COLS = `, value, invoiced, paid, due, overdue, is_mockup`;

function mapRow(x: Record<string, unknown>, withValue: boolean): TrackerRow {
  const row: TrackerRow = {
    soId: Number(x.so_id),
    spkNo: String(x.spk_no),
    quotationName: (x.quotation_name as string) ?? null,
    track: x.tracker_stage as TrackStage,
    dateOrder: (x.date_order as Date) ?? null,
    customer: (x.customer as string) ?? null,
    brand: (x.brand as string) ?? null,
    ae: (x.ae as string) ?? null,
    locations: Number(x.locations),
    stage: String(x.stage),
    progress: Number(x.progress_pct),
    crewHours: Number(x.crew_hours),
    crewPeople: Number(x.crew_people),
    invoiceCount: Number(x.invoice_count),
    nextDueDate: (x.next_due_date as Date) ?? null,
    paymentCount: Number(x.payment_count),
    lastPaymentDate: (x.last_payment_date as Date) ?? null,
  };
  if (withValue) {
    row.value = Number(x.value);
    row.invoiced = Number(x.invoiced);
    row.paid = Number(x.paid);
    row.due = Number(x.due);
    row.overdue = Number(x.overdue);
    row.isMockup = x.is_mockup === true;
  }
  return row;
}

export async function getQuotationTracker(sub: string, access: ClientAccess, p: TrackerParams): Promise<QuotationTracker> {
  const withValue = access.canSeeValue;
  const aeLogin = aeOnly(access) ? access.login : "";
  return withMart({ sub, client: access.client }, async (c, env) => {
    // $1-$3 = FILTER (dipakai semua query), $4 = tahap (hanya query yang memakainya — Postgres menolak parameter
    // yang tidak dirujuk karena tipenya tak bisa ditentukan).
    const args = [env, p.q, aeLogin];
    const withTrack = [...args, p.track];
    const sort = !withValue && p.sort === "value_desc" ? "date_desc" : p.sort;
    const list = await c.query(
      `SELECT ${BASE_COLS}${withValue ? VALUE_COLS : ""} FROM mart.mart_spk
        WHERE ${FILTER} ${TRACK_FILTER} ORDER BY ${ORDER_BY[sort]} LIMIT $5 OFFSET $6`,
      [...withTrack, p.pageSize, (p.page - 1) * p.pageSize],
    );
    // Funnel tidak ikut filter tahap (agar semua langkah tetap terlihat), hanya pencarian & lingkup AE.
    const agg = await c.query(
      `SELECT count(*) FILTER (WHERE ($4::text = '' AND tracker_stage <> 'batal') OR tracker_stage = $4)::int AS total,
              count(*) FILTER (WHERE tracker_stage <> 'batal')::int AS quotations,
              count(*) FILTER (WHERE tracker_stage IN ('spk','produksi','ditagih','lunas'))::int AS spk,
              count(*) FILTER (WHERE tracker_stage IN ('produksi','ditagih','lunas'))::int AS produksi,
              count(*) FILTER (WHERE tracker_stage <> 'batal' AND crew_hours > 0)::int AS absensi,
              count(*) FILTER (WHERE tracker_stage IN ('ditagih','lunas'))::int AS ditagih,
              count(*) FILTER (WHERE tracker_stage = 'lunas')::int AS lunas,
              count(*) FILTER (WHERE tracker_stage = 'penawaran')::int AS cur_penawaran,
              count(*) FILTER (WHERE tracker_stage = 'spk')::int AS cur_spk,
              count(*) FILTER (WHERE tracker_stage = 'produksi')::int AS cur_produksi,
              count(*) FILTER (WHERE tracker_stage = 'ditagih')::int AS cur_ditagih,
              count(*) FILTER (WHERE tracker_stage = 'batal')::int AS batal,
              coalesce(sum(crew_hours) FILTER (WHERE tracker_stage <> 'batal'), 0) AS crew_hours,
              max(refreshed_at) AS refreshed_at
         FROM mart.mart_spk WHERE ${FILTER}`,
      withTrack,
    );
    const a = agg.rows[0];
    const funnel: FunnelStep[] = [
      { key: "penawaran", label: "Penawaran", reached: a.quotations, current: a.cur_penawaran },
      { key: "spk", label: "SPK", reached: a.spk, current: a.cur_spk },
      { key: "produksi", label: "Produksi", reached: a.produksi, current: a.cur_produksi },
      { key: "absensi", label: "Absensi kru", reached: a.absensi, current: 0 },
      { key: "ditagih", label: "Ditagih", reached: a.ditagih, current: a.cur_ditagih },
      { key: "lunas", label: "Lunas", reached: a.lunas, current: a.lunas },
    ];
    const result: QuotationTracker = {
      rows: list.rows.map((x) => mapRow(x, withValue)),
      total: a.total,
      refreshedAt: a.refreshed_at ?? null,
      funnel,
      cancelled: a.batal,
      crewHours: Number(a.crew_hours),
    };
    if (withValue) {
      const v = await c.query(
        `SELECT coalesce(sum(value) FILTER (WHERE tracker_stage = 'penawaran'), 0) AS quoted,
                coalesce(sum(value) FILTER (WHERE tracker_stage IN ('spk','produksi','ditagih','lunas')), 0) AS spk,
                coalesce(sum(invoiced), 0) AS invoiced, coalesce(sum(paid), 0) AS paid,
                coalesce(sum(due), 0) AS due, coalesce(sum(overdue), 0) AS overdue,
                coalesce(bool_or(is_mockup), false) AS is_mockup
           FROM mart.mart_spk WHERE ${FILTER} AND tracker_stage <> 'batal'`,
        args,
      );
      const x = v.rows[0];
      result.value = {
        quoted: Number(x.quoted),
        spk: Number(x.spk),
        invoiced: Number(x.invoiced),
        paid: Number(x.paid),
        due: Number(x.due),
        overdue: Number(x.overdue),
        isMockup: x.is_mockup === true,
      };
      const amounts: Record<string, number> = {
        penawaran: result.value.quoted + result.value.spk,
        spk: result.value.spk,
        ditagih: result.value.invoiced,
        lunas: result.value.paid,
      };
      for (const step of funnel) if (step.key in amounts) step.amount = amounts[step.key];
    }
    return result;
  });
}
