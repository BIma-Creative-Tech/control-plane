import { z } from "zod";

/** Validasi searchParams dashboard SPK (server side). Nilai tak valid → default aman, bukan error. */
export const SPK_SORTS = ["date_desc", "date_asc", "stage_asc", "last_desc", "value_desc"] as const;

const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .regex(/^[^\u0000-\u001f]*$/)
    .default("")
    .catch("");

const schema = z.object({
  client: z
    .string()
    .regex(/^[a-z0-9_]{3,30}$/)
    .optional()
    .catch(undefined),
  q: text(60),
  stage: text(40),
  status: z.enum(["spk", "penawaran", ""]).default("spk").catch("spk"),
  sort: z.enum(SPK_SORTS).default("date_desc").catch("date_desc"),
  page: z.coerce.number().int().min(1).max(1000).default(1).catch(1),
  pageSize: z.literal(50).default(50).catch(50),
});

export type SpkListParams = z.infer<typeof schema>;

export function parseSpkListParams(raw: Record<string, string | string[] | undefined>): SpkListParams {
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  return schema.parse({
    client: first(raw.client) || undefined,
    q: first(raw.q),
    stage: first(raw.stage),
    status: first(raw.status),
    sort: first(raw.sort),
    page: first(raw.page),
    pageSize: 50,
  });
}

/** Query string untuk link (hanya parameter non-default). */
export function spkQuery(p: Partial<SpkListParams>, override: Partial<SpkListParams> = {}): string {
  const merged = { ...p, ...override };
  const sp = new URLSearchParams();
  if (merged.client) sp.set("client", merged.client);
  if (merged.q) sp.set("q", merged.q);
  if (merged.stage) sp.set("stage", merged.stage);
  if (merged.status !== undefined && merged.status !== "spk") sp.set("status", merged.status);
  if (merged.sort && merged.sort !== "date_desc") sp.set("sort", merged.sort);
  if (merged.page && merged.page > 1) sp.set("page", String(merged.page));
  const s = sp.toString();
  return s ? `?${s}` : "";
}

/**
 * Quotation Tracker (plan infra 15): tahap terjauh alur Penawaran → SPK → Produksi → Ditagih → Lunas
 * (`mart_spk.tracker_stage`). "" = semua kecuali batal.
 */
export const TRACK_STAGES = ["penawaran", "spk", "produksi", "ditagih", "lunas", "batal"] as const;
export type TrackStage = (typeof TRACK_STAGES)[number];

const trackerSchema = schema.pick({ client: true, q: true, sort: true, page: true, pageSize: true }).extend({
  track: z.enum([...TRACK_STAGES, ""]).default("").catch(""),
});

export type TrackerParams = z.infer<typeof trackerSchema>;

export function parseTrackerParams(raw: Record<string, string | string[] | undefined>): TrackerParams {
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  return trackerSchema.parse({
    client: first(raw.client) || undefined,
    q: first(raw.q),
    track: first(raw.track),
    sort: first(raw.sort),
    page: first(raw.page),
    pageSize: 50,
  });
}

export function trackerQuery(p: Partial<TrackerParams>, override: Partial<TrackerParams> = {}): string {
  const merged = { ...p, ...override };
  const sp = new URLSearchParams();
  if (merged.client) sp.set("client", merged.client);
  if (merged.q) sp.set("q", merged.q);
  if (merged.track) sp.set("track", merged.track);
  if (merged.sort && merged.sort !== "date_desc") sp.set("sort", merged.sort);
  if (merged.page && merged.page > 1) sp.set("page", String(merged.page));
  const s = sp.toString();
  return s ? `?${s}` : "";
}
