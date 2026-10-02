import "server-only";

/**
 * Sumber `mart.mart_spk` + kolom turunan untuk status penawaran (dibuat vs terkirim):
 * - `q_state`: 'dibuat' | 'terkirim' untuk baris status 'penawaran', NULL untuk SPK/batal;
 * - `track`: tahap Quotation Tracker dengan penawaran terkirim dipisah ('terkirim'), selain itu = `tracker_stage`.
 * `quotation_state` dibaca lewat `to_jsonb(m)` agar query tetap jalan pada data mart lama yang belum punya kolom itu
 * (semua penawaran lalu dianggap 'dibuat'). Teks tetap, tanpa input user → aman digabung ke SQL.
 * - `issues`: jumlah isu link dokumen terbuka (plan 18, `issue_count`); mart lama tanpa kolom itu → 0.
 * - `bast_n` / `bast_done` / `bast_half`: BAST tidak batal / lengkap / TTD satu pihak (plan 19, `bast_*`); mart lama → 0.
 * - `cost_sum` / `margin_amt` / `margin_rate`: total biaya & margin (plan 19) — NILAI, hanya dipilih bila canSeeValue;
 *   mart lama → NULL. `j` = baris utuh (to_jsonb) untuk detail biaya — juga hanya dipilih bila canSeeValue.
 */
const Q_STATE = `CASE WHEN m.status = 'penawaran' THEN coalesce(to_jsonb(m) ->> 'quotation_state', 'dibuat') END`;

export const MART_SPK = `(SELECT m.*, ${Q_STATE} AS q_state,
    CASE WHEN m.tracker_stage = 'penawaran' AND ${Q_STATE} = 'terkirim' THEN 'terkirim' ELSE m.tracker_stage END AS track,
    coalesce((to_jsonb(m) ->> 'issue_count')::int, 0) AS issues,
    coalesce((to_jsonb(m) ->> 'bast_count')::int, 0) AS bast_n,
    coalesce((to_jsonb(m) ->> 'bast_completed')::int, 0) AS bast_done,
    coalesce((to_jsonb(m) ->> 'bast_partial')::int, 0) AS bast_half,
    (to_jsonb(m) ->> 'cost_total')::numeric AS cost_sum,
    (to_jsonb(m) ->> 'margin')::numeric AS margin_amt,
    (to_jsonb(m) ->> 'margin_pct')::numeric AS margin_rate,
    to_jsonb(m) AS j
  FROM mart.mart_spk m) s`;
