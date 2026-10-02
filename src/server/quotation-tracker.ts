import "server-only";
import { withMart } from "@/db/datamart";
import type { TrackStage, TrackerParams } from "@/lib/spk-params";
import { MART_SPK } from "@/server/mart-spk";
import { aeOnly, type ClientAccess } from "@/server/spk-dashboard";

/**
 * Quotation Tracker (plan infra 15/16): satu baris per Penawaran/SPK dari `mart.mart_spk` dengan tahap terjauh
 * (`tracker_stage`; penawaran dibuat/terkirim dipisah, lihat `mart-spk.ts`) Penawaran → SPK → Produksi → Ditagih → Lunas, plus ringkasan absensi kru (timesheet),
 * supply chain (PO, produksi/MO, surat jalan), penagihan dan pembayaran. Funnel diawali lead CRM (`mart.mart_lead`).
 * Aturan akses sama dengan dashboard SPK: kolom Rp hanya DIPILIH bila `canSeeValue`, AE murni hanya melihat
 * miliknya, isolasi client = RLS.
 */

const FILTER = `
  env = $1
  AND ($2::text = '' OR spk_no ILIKE '%' || $2 || '%' OR quotation_name ILIKE '%' || $2 || '%'
       OR legacy_ref ILIKE '%' || $2 || '%' OR customer ILIKE '%' || $2 || '%' OR brand ILIKE '%' || $2 || '%'
       OR ae ILIKE '%' || $2 || '%')
  AND ($3::text = '' OR ae_login = $3)`;
const TRACK_FILTER = `AND (($4::text = '' AND track <> 'batal') OR track = $4)`;

const ORDER_BY: Record<TrackerParams["sort"], string> = {
  date_desc: "date_order DESC NULLS LAST, so_id DESC",
  date_asc: "date_order ASC NULLS LAST, so_id ASC",
  stage_asc: "array_position(ARRAY['penawaran','terkirim','spk','produksi','ditagih','lunas','batal'], track), date_order DESC NULLS LAST",
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
  poCount: number;
  moCount: number;
  moDone: number;
  deliveryCount: number;
  deliveryDone: number;
  value?: number;
  materialCost?: number;
  invoiced?: number;
  paid?: number;
  due?: number;
  overdue?: number;
  isMockup?: boolean;
};

/** Langkah funnel: `reached` = jumlah yang sudah melewati/berada di langkah ini, `current` = berhenti di sini. */
export type FunnelStep = { key: string; label: string; reached: number; current: number; amount?: number };

/** Lead CRM yang belum menjadi penawaran (terbaru). */
export type LeadRow = {
  leadId: number;
  name: string;
  stage: string | null;
  customer: string | null;
  brand: string | null;
  ae: string | null;
  createdAt: Date | null;
  expectedRevenue?: number;
};

export type QuotationTracker = {
  rows: TrackerRow[];
  openLeads: LeadRow[];
  total: number;
  refreshedAt: Date | null;
  funnel: FunnelStep[];
  cancelled: number;
  crewHours: number;
  value?: {
    quoted: number; quotedSent: number; spk: number; invoiced: number; paid: number; due: number; overdue: number; isMockup: boolean;
    pipeline: number; materialCost: number; vendorDue: number;
  };
};

const BASE_COLS = `so_id, spk_no, quotation_name, track, date_order, customer, brand, ae, locations, stage,
  progress_pct, crew_hours, crew_people, invoice_count, next_due_date, payment_count, last_payment_date,
  po_count, mo_count, mo_done, delivery_count, delivery_done`;
const VALUE_COLS = `, value, invoiced, paid, due, overdue, is_mockup, material_cost`;
const LEAD_FILTER = `
  env = $1
  AND ($2::text = '' OR name ILIKE '%' || $2 || '%' OR customer ILIKE '%' || $2 || '%' OR brand ILIKE '%' || $2 || '%'
       OR ae ILIKE '%' || $2 || '%')
  AND ($3::text = '' OR ae_login = $3)`;

function mapRow(x: Record<string, unknown>, withValue: boolean): TrackerRow {
  const row: TrackerRow = {
    soId: Number(x.so_id),
    spkNo: String(x.spk_no),
    quotationName: (x.quotation_name as string) ?? null,
    track: x.track as TrackStage,
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
    poCount: Number(x.po_count),
    moCount: Number(x.mo_count),
    moDone: Number(x.mo_done),
    deliveryCount: Number(x.delivery_count),
    deliveryDone: Number(x.delivery_done),
  };
  if (withValue) {
    row.value = Number(x.value);
    row.invoiced = Number(x.invoiced);
    row.paid = Number(x.paid);
    row.due = Number(x.due);
    row.overdue = Number(x.overdue);
    row.isMockup = x.is_mockup === true;
    row.materialCost = Number(x.material_cost);
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
      `SELECT ${BASE_COLS}${withValue ? VALUE_COLS : ""} FROM ${MART_SPK}
        WHERE ${FILTER} ${TRACK_FILTER} ORDER BY ${ORDER_BY[sort]} LIMIT $5 OFFSET $6`,
      [...withTrack, p.pageSize, (p.page - 1) * p.pageSize],
    );
    // Funnel tidak ikut filter tahap (agar semua langkah tetap terlihat), hanya pencarian & lingkup AE.
    const agg = await c.query(
      `SELECT count(*) FILTER (WHERE ($4::text = '' AND track <> 'batal') OR track = $4)::int AS total,
              count(*) FILTER (WHERE track <> 'batal')::int AS quotations,
              count(*) FILTER (WHERE track IN ('spk','produksi','ditagih','lunas'))::int AS spk,
              count(*) FILTER (WHERE track <> 'batal' AND po_count > 0)::int AS pengadaan,
              count(*) FILTER (WHERE track IN ('produksi','ditagih','lunas'))::int AS produksi,
              count(*) FILTER (WHERE track <> 'batal' AND delivery_done > 0)::int AS dikirim,
              count(*) FILTER (WHERE track <> 'batal' AND crew_hours > 0)::int AS absensi,
              count(*) FILTER (WHERE track IN ('ditagih','lunas'))::int AS ditagih,
              count(*) FILTER (WHERE track = 'lunas')::int AS lunas,
              count(*) FILTER (WHERE track = 'penawaran')::int AS cur_penawaran,
              count(*) FILTER (WHERE track = 'terkirim')::int AS cur_terkirim,
              count(*) FILTER (WHERE track = 'spk')::int AS cur_spk,
              count(*) FILTER (WHERE track = 'produksi')::int AS cur_produksi,
              count(*) FILTER (WHERE track = 'ditagih')::int AS cur_ditagih,
              count(*) FILTER (WHERE track = 'batal')::int AS batal,
              coalesce(sum(crew_hours) FILTER (WHERE track <> 'batal'), 0) AS crew_hours,
              max(refreshed_at) AS refreshed_at
         FROM ${MART_SPK} WHERE ${FILTER}`,
      withTrack,
    );
    // Lead CRM: semua lead/opportunity aktif atau menang/kalah (tanpa arsip); "berhenti di sini" = belum ada penawaran.
    const leadAgg = await c.query(
      `SELECT count(*)::int AS leads,
              count(*) FILTER (WHERE status = 'open' AND NOT has_quotation)::int AS open_no_quote,
              coalesce(sum(expected_revenue) FILTER (WHERE status = 'open' AND NOT has_quotation), 0) AS pipeline
         FROM mart.mart_lead WHERE ${LEAD_FILTER}`,
      args,
    );
    const openLeads = await c.query(
      `SELECT lead_id, name, stage, customer, brand, ae, create_date${withValue ? ", expected_revenue" : ""}
         FROM mart.mart_lead WHERE ${LEAD_FILTER} AND status = 'open' AND NOT has_quotation
        ORDER BY create_date DESC NULLS LAST, lead_id DESC LIMIT 10`,
      args,
    );
    const a = agg.rows[0];
    const l = leadAgg.rows[0];
    const funnel: FunnelStep[] = [
      { key: "lead", label: "Lead CRM", reached: Math.max(l.leads, a.quotations), current: l.open_no_quote },
      { key: "penawaran", label: "Penawaran dibuat", reached: a.quotations, current: a.cur_penawaran },
      // Terkirim = semua yang sudah lewat draft (SPK yang dikonfirmasi tanpa "Mark as Sent" tetap terhitung).
      { key: "terkirim", label: "Penawaran terkirim", reached: a.quotations - a.cur_penawaran, current: a.cur_terkirim },
      { key: "spk", label: "SPK", reached: a.spk, current: a.cur_spk },
      { key: "pengadaan", label: "Pengadaan (PO)", reached: a.pengadaan, current: 0 },
      { key: "produksi", label: "Produksi", reached: a.produksi, current: a.cur_produksi },
      { key: "dikirim", label: "Terkirim (surat jalan)", reached: a.dikirim, current: 0 },
      { key: "absensi", label: "Absensi kru", reached: a.absensi, current: 0 },
      { key: "ditagih", label: "Ditagih", reached: a.ditagih, current: a.cur_ditagih },
      { key: "lunas", label: "Lunas", reached: a.lunas, current: a.lunas },
    ];
    const result: QuotationTracker = {
      rows: list.rows.map((x) => mapRow(x, withValue)),
      openLeads: openLeads.rows.map((x) => ({
        leadId: Number(x.lead_id),
        name: String(x.name),
        stage: (x.stage as string) ?? null,
        customer: (x.customer as string) ?? null,
        brand: (x.brand as string) ?? null,
        ae: (x.ae as string) ?? null,
        createdAt: (x.create_date as Date) ?? null,
        ...(withValue ? { expectedRevenue: Number(x.expected_revenue) } : {}),
      })),
      total: a.total,
      refreshedAt: a.refreshed_at ?? null,
      funnel,
      cancelled: a.batal,
      crewHours: Number(a.crew_hours),
    };
    if (withValue) {
      const v = await c.query(
        `SELECT coalesce(sum(value) FILTER (WHERE track IN ('penawaran','terkirim')), 0) AS quoted,
                coalesce(sum(value) FILTER (WHERE track = 'terkirim'), 0) AS quoted_sent,
                coalesce(sum(value) FILTER (WHERE track IN ('spk','produksi','ditagih','lunas')), 0) AS spk,
                coalesce(sum(invoiced), 0) AS invoiced, coalesce(sum(paid), 0) AS paid,
                coalesce(sum(due), 0) AS due, coalesce(sum(overdue), 0) AS overdue,
                coalesce(bool_or(is_mockup), false) AS is_mockup,
                coalesce(sum(material_cost), 0) AS material_cost,
                coalesce(sum(vendor_billed - vendor_paid), 0) AS vendor_due
           FROM ${MART_SPK} WHERE ${FILTER} AND track <> 'batal'`,
        args,
      );
      const x = v.rows[0];
      result.value = {
        quoted: Number(x.quoted),
        quotedSent: Number(x.quoted_sent),
        spk: Number(x.spk),
        invoiced: Number(x.invoiced),
        paid: Number(x.paid),
        due: Number(x.due),
        overdue: Number(x.overdue),
        isMockup: x.is_mockup === true,
        pipeline: Number(l.pipeline),
        materialCost: Number(x.material_cost),
        vendorDue: Number(x.vendor_due),
      };
      const amounts: Record<string, number> = {
        lead: result.value.pipeline,
        pengadaan: result.value.materialCost,
        penawaran: result.value.quoted + result.value.spk,
        terkirim: result.value.quotedSent + result.value.spk,
        spk: result.value.spk,
        ditagih: result.value.invoiced,
        lunas: result.value.paid,
      };
      for (const step of funnel) if (step.key in amounts) step.amount = amounts[step.key];
    }
    return result;
  });
}
