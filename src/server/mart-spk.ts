import "server-only";

/**
 * Sumber `mart.mart_spk` + kolom turunan untuk status penawaran (dibuat vs terkirim):
 * - `q_state`: 'dibuat' | 'terkirim' untuk baris status 'penawaran', NULL untuk SPK/batal;
 * - `track`: tahap Quotation Tracker dengan penawaran terkirim dipisah ('terkirim'), selain itu = `tracker_stage`.
 * `quotation_state` dibaca lewat `to_jsonb(m)` agar query tetap jalan pada data mart lama yang belum punya kolom itu
 * (semua penawaran lalu dianggap 'dibuat'). Teks tetap, tanpa input user → aman digabung ke SQL.
 */
const Q_STATE = `CASE WHEN m.status = 'penawaran' THEN coalesce(to_jsonb(m) ->> 'quotation_state', 'dibuat') END`;

export const MART_SPK = `(SELECT m.*, ${Q_STATE} AS q_state,
    CASE WHEN m.tracker_stage = 'penawaran' AND ${Q_STATE} = 'terkirim' THEN 'terkirim' ELSE m.tracker_stage END AS track
  FROM mart.mart_spk m) s`;
