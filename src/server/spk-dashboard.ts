import "server-only";
import type { PoolClient } from "pg";
import { withMart } from "@/db/datamart";
import type { SpkListParams } from "@/lib/spk-params";

/**
 * Query dashboard SPK (ADR 0016). Semua SQL konstanta + parameter posisi; kolom nilai (Rp) hanya DIPILIH bila
 * `canSeeValue` (dari grup Odoo lewat mart_user_access) — pengguna tanpa hak tidak pernah menerima angka nilai.
 * Isolasi client = RLS (app.client), daftar client milik user = RLS (app.sub).
 */

export type ClientAccess = {
  client: string;
  login: string;
  name: string;
  canSeeValue: boolean;
  isProjectUser: boolean;
  isAe: boolean;
};

/** Lingkup baris untuk peran: Owner/Finance & PM melihat semua SPK tenant; AE murni hanya SPK miliknya. */
export function aeOnly(a: ClientAccess): boolean {
  return a.isAe && !a.canSeeValue && !a.isProjectUser;
}

export async function listAccess(sub: string): Promise<ClientAccess[]> {
  return withMart({ sub }, async (c, env) => {
    const r = await c.query(
      `SELECT client_slug, login, name, can_see_value, is_project_user, is_ae
         FROM mart.mart_user_access WHERE env = $1 ORDER BY client_slug`,
      [env],
    );
    return r.rows.map((x) => ({
      client: x.client_slug,
      login: x.login,
      name: x.name,
      canSeeValue: x.can_see_value === true,
      isProjectUser: x.is_project_user === true,
      isAe: x.is_ae === true,
    }));
  });
}

/** Akses user untuk satu client; null bila user tidak terdaftar di tenant itu (akses ditolak). */
export async function accessFor(sub: string, client: string): Promise<ClientAccess | null> {
  return (await listAccess(sub)).find((a) => a.client === client) ?? null;
}

const FILTER = `
  env = $1
  AND ($2::text = '' OR spk_no ILIKE '%' || $2 || '%' OR legacy_ref ILIKE '%' || $2 || '%'
       OR customer ILIKE '%' || $2 || '%' OR brand ILIKE '%' || $2 || '%' OR ae ILIKE '%' || $2 || '%')
  AND ($3::text = '' OR stage = $3)
  AND ($4::text = '' OR status = $4)
  AND ($5::text = '' OR ae_login = $5)`;

// Urutan hanya dari daftar tetap (bukan input bebas) → aman digabung ke SQL.
const ORDER_BY: Record<SpkListParams["sort"], string> = {
  date_desc: "date_order DESC NULLS LAST, so_id DESC",
  date_asc: "date_order ASC NULLS LAST, so_id ASC",
  stage_asc: "stage_seq ASC, date_order DESC NULLS LAST",
  last_desc: "last_status_at DESC NULLS LAST, so_id DESC",
  value_desc: "value DESC NULLS LAST, so_id DESC",
};

export type SpkRow = {
  soId: number;
  spkNo: string;
  legacyRef: string | null;
  status: string;
  dateOrder: Date | null;
  customer: string | null;
  brand: string | null;
  ae: string | null;
  locations: number;
  stage: string;
  stageSeq: number;
  progress: number;
  lastStatus: string | null;
  lastStatusAt: Date | null;
  crewHours: number;
  value?: number;
  invoiced?: number;
  paid?: number;
  due?: number;
  isMockup?: boolean;
};

export type SpkDashboard = {
  rows: SpkRow[];
  total: number;
  refreshedAt: Date | null;
  kpi: { spk: number; quotations: number; locations: number; done: number; waitingBast: number; inProgress: number };
  stages: { stage: string; seq: number; count: number }[];
  value?: { total: number; invoiced: number; paid: number; due: number; isMockup: boolean };
  valueByCustomer?: { customer: string; value: number }[];
  customers: string[];
};

function mapRow(x: Record<string, unknown>, withValue: boolean): SpkRow {
  const row: SpkRow = {
    soId: Number(x.so_id),
    spkNo: String(x.spk_no),
    legacyRef: (x.legacy_ref as string) ?? null,
    status: String(x.status),
    dateOrder: (x.date_order as Date) ?? null,
    customer: (x.customer as string) ?? null,
    brand: (x.brand as string) ?? null,
    ae: (x.ae as string) ?? null,
    locations: Number(x.locations),
    stage: String(x.stage),
    stageSeq: Number(x.stage_seq),
    progress: Number(x.progress_pct),
    lastStatus: (x.last_status as string) ?? null,
    lastStatusAt: (x.last_status_at as Date) ?? null,
    crewHours: Number(x.crew_hours),
  };
  if (withValue) {
    row.value = Number(x.value);
    row.invoiced = Number(x.invoiced);
    row.paid = Number(x.paid);
    row.due = Number(x.due);
    row.isMockup = x.is_mockup === true;
  }
  return row;
}

const BASE_COLS = `so_id, spk_no, legacy_ref, status, date_order, customer, brand, ae, locations, stage, stage_seq,
  progress_pct, last_status, last_status_at, crew_hours`;
const VALUE_COLS = `, value, invoiced, paid, due, is_mockup`;

export async function getSpkDashboard(sub: string, access: ClientAccess, p: SpkListParams): Promise<SpkDashboard> {
  const withValue = access.canSeeValue;
  const aeLogin = aeOnly(access) ? access.login : "";
  return withMart({ sub, client: access.client }, async (c: PoolClient, env) => {
    const args = [env, p.q, p.stage, p.status, aeLogin];
    // Kolom nilai & urutan nilai hanya untuk yang berhak; selain itu urutan nilai jatuh ke tanggal.
    const sort = !withValue && p.sort === "value_desc" ? "date_desc" : p.sort;
    const cols = BASE_COLS + (withValue ? VALUE_COLS : "");
    const list = await c.query(
      `SELECT ${cols} FROM mart.mart_spk WHERE ${FILTER} ORDER BY ${ORDER_BY[sort]} LIMIT $6 OFFSET $7`,
      [...args, p.pageSize, (p.page - 1) * p.pageSize],
    );
    const agg = await c.query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE status = 'spk')::int AS spk,
              count(*) FILTER (WHERE status = 'penawaran')::int AS quotations,
              coalesce(sum(locations) FILTER (WHERE status = 'spk'), 0)::int AS locations,
              count(*) FILTER (WHERE status = 'spk' AND stage IN ('BAST', 'Selesai'))::int AS done,
              count(*) FILTER (WHERE status = 'spk' AND stage = 'Laporan')::int AS waiting_bast,
              count(*) FILTER (WHERE status = 'spk' AND stage NOT IN ('BAST', 'Selesai', 'Laporan'))::int AS in_progress,
              max(refreshed_at) AS refreshed_at
         FROM mart.mart_spk WHERE ${FILTER}`,
      args,
    );
    const stages = await c.query(
      `SELECT stage, min(stage_seq)::int AS seq, count(*)::int AS count FROM mart.mart_spk
        WHERE ${FILTER} AND status = 'spk' GROUP BY stage ORDER BY 2`,
      args,
    );
    const customers = await c.query(
      `SELECT DISTINCT customer FROM mart.mart_spk WHERE env = $1 AND customer IS NOT NULL
         AND ($2::text = '' OR ae_login = $2) ORDER BY 1`,
      [env, aeLogin],
    );
    const a = agg.rows[0];
    const result: SpkDashboard = {
      rows: list.rows.map((x) => mapRow(x, withValue)),
      total: a.total,
      refreshedAt: a.refreshed_at ?? null,
      kpi: {
        spk: a.spk,
        quotations: a.quotations,
        locations: a.locations,
        done: a.done,
        waitingBast: a.waiting_bast,
        inProgress: a.in_progress,
      },
      stages: stages.rows.map((x) => ({ stage: x.stage, seq: x.seq, count: x.count })),
      customers: customers.rows.map((x) => x.customer as string),
    };
    if (withValue) {
      const v = await c.query(
        `SELECT coalesce(sum(value), 0) AS total, coalesce(sum(invoiced), 0) AS invoiced, coalesce(sum(paid), 0) AS paid,
                coalesce(sum(due), 0) AS due, coalesce(bool_or(is_mockup), false) AS is_mockup
           FROM mart.mart_spk WHERE ${FILTER} AND status = 'spk'`,
        args,
      );
      const byCustomer = await c.query(
        `SELECT coalesce(customer, '-') AS customer, sum(value) AS value FROM mart.mart_spk
          WHERE ${FILTER} AND status = 'spk' GROUP BY 1 ORDER BY 2 DESC LIMIT 8`,
        args,
      );
      const x = v.rows[0];
      result.value = {
        total: Number(x.total),
        invoiced: Number(x.invoiced),
        paid: Number(x.paid),
        due: Number(x.due),
        isMockup: x.is_mockup === true,
      };
      result.valueByCustomer = byCustomer.rows.map((r) => ({ customer: r.customer, value: Number(r.value) }));
    }
    return result;
  });
}

export type SpkDetail = {
  spk: SpkRow & { quotationName: string | null };
  locations: {
    taskId: number;
    location: string;
    stage: string;
    progress: number;
    deadline: Date | null;
    crewHours: number;
    crewPeople: number;
    lastActivity: string | null;
    lastActivityDate: Date | null;
    value?: number;
  }[];
  activities: {
    date: Date;
    slot: string | null;
    type: string | null;
    description: string | null;
    crew: string | null;
    hours: number;
    people: number;
  }[];
};

export async function getSpkDetail(sub: string, access: ClientAccess, soId: number): Promise<SpkDetail | null> {
  const withValue = access.canSeeValue;
  const aeLogin = aeOnly(access) ? access.login : "";
  return withMart({ sub, client: access.client }, async (c, env) => {
    const head = await c.query(
      `SELECT ${BASE_COLS}${withValue ? VALUE_COLS : ""}, quotation_name FROM mart.mart_spk
        WHERE env = $1 AND so_id = $2 AND ($3::text = '' OR ae_login = $3)`,
      [env, soId, aeLogin],
    );
    if (head.rowCount === 0) return null;
    const locs = await c.query(
      `SELECT task_id, location, stage, progress_pct, date_deadline, crew_hours, crew_people, last_activity,
              last_activity_date${withValue ? ", value" : ""}
         FROM mart.mart_spk_location WHERE env = $1 AND so_id = $2 ORDER BY stage_seq, task_id`,
      [env, soId],
    );
    const acts = await c.query(
      `SELECT date, slot, activity_type, description, crew, hours, people FROM mart.mart_spk_activity
        WHERE env = $1 AND so_id = $2 ORDER BY date DESC, slot LIMIT 200`,
      [env, soId],
    );
    const h = head.rows[0];
    return {
      spk: { ...mapRow(h, withValue), quotationName: h.quotation_name ?? null },
      locations: locs.rows.map((x) => ({
        taskId: Number(x.task_id),
        location: x.location,
        stage: x.stage ?? "-",
        progress: Number(x.progress_pct),
        deadline: x.date_deadline ?? null,
        crewHours: Number(x.crew_hours),
        crewPeople: Number(x.crew_people),
        lastActivity: x.last_activity ?? null,
        lastActivityDate: x.last_activity_date ?? null,
        ...(withValue ? { value: Number(x.value) } : {}),
      })),
      activities: acts.rows.map((x) => ({
        date: x.date,
        slot: x.slot ?? null,
        type: x.activity_type ?? null,
        description: x.description ?? null,
        crew: x.crew ?? null,
        hours: Number(x.hours),
        people: Number(x.people),
      })),
    };
  });
}
