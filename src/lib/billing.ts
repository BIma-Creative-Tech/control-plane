/**
 * Siklus langganan & tagihan (ADR 0018 D4/D5/D7/D8) — modul MURNI (tanpa DB/Next/nodemailer), diuji unit.
 *
 * Tanggal bisnis = tanggal kalender Asia/Jakarta (WIB, UTC+7 tanpa DST) berbentuk `YYYY-MM-DD`. Kolom timestamptz
 * lama (`current_period_start` = starts_at, `current_period_end` = ends_at, `grace_until`) disimpan sebagai 00:00 WIB
 * tanggal tersebut (dateToTimestamp/timestampToDate).
 *
 * Tabel transisi ADR 0018 D4 (persis):
 *   (baru)                 → implementation  (createSubscription)
 *   implementation         → warranty        Go-live: go_live_at, warranty_until = go_live_at + 2 bulan
 *   warranty               → active          tick: today > warranty_until → starts = warranty_until,
 *                                            ends = starts + periode plan, invoice maintenance pertama
 *   active                 → past_due        tick: today > ends → grace_until = ends + 2 bulan
 *   past_due               → suspended       tick: today > grace_until → enqueue tenant_suspend
 *   past_due|suspended     → active          invoice maintenance lunas → ends + satu periode (suspended → tenant_resume)
 *   apa pun                → terminated      manual platform-admin
 * implementation/warranty TIDAK PERNAH disuspend otomatis. `pending`/`grace` USANG: tidak ada transisi.
 */

import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------
/** Urutan = enum DB `subscription_status` (0000 + 0005). */
export const SUBSCRIPTION_STATUSES = [
  "pending",
  "active",
  "grace",
  "suspended",
  "terminated",
  "implementation",
  "warranty",
  "past_due",
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

/** Nilai usang ADR 0018 D4 — tidak pernah ditulis kode baru. */
export const DEPRECATED_SUBSCRIPTION_STATUSES = ["pending", "grace"] as const satisfies readonly SubscriptionStatus[];

/** Status siklus yang dipakai kode baru (urutan tampilan). */
export const LIFECYCLE_STATUSES = [
  "implementation",
  "warranty",
  "active",
  "past_due",
  "suspended",
  "terminated",
] as const satisfies readonly SubscriptionStatus[];

export function isDeprecatedStatus(s: SubscriptionStatus): boolean {
  return (DEPRECATED_SUBSCRIPTION_STATUSES as readonly string[]).includes(s);
}

/** Status yang boleh ditagih invoice maintenance (punya periode berjalan). */
export const BILLABLE_STATUSES = ["active", "past_due", "suspended"] as const satisfies readonly SubscriptionStatus[];

export function isBillable(s: SubscriptionStatus): boolean {
  return (BILLABLE_STATUSES as readonly string[]).includes(s);
}

export const WARRANTY_MONTHS = 2;
export const GRACE_MONTHS = 2;

/** Label UI (bahasa Indonesia). */
export const SUBSCRIPTION_STATUS_LABELS: Record<SubscriptionStatus, string> = {
  implementation: "implementasi",
  warranty: "garansi",
  active: "aktif",
  past_due: "lewat jatuh tempo",
  suspended: "ditangguhkan",
  terminated: "diakhiri",
  pending: "pending (usang)",
  grace: "grace (usang)",
};

// ---------------------------------------------------------------------------
// Tanggal (WIB)
// ---------------------------------------------------------------------------
export type IsoDate = string;

const ISO_DATE_RE = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;
const WIB_OFFSET_MS = 7 * 3600_000;

function daysInMonth(year: number, month1: number): number {
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}

function parts(d: IsoDate): [number, number, number] {
  const m = ISO_DATE_RE.exec(d);
  if (!m) throw new RangeError("tanggal harus YYYY-MM-DD");
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const day = Number(m[3]);
  if (mo < 1 || mo > 12 || day < 1 || day > daysInMonth(y, mo) || y < 2000 || y > 2200) throw new RangeError("tanggal tidak valid");
  return [y, mo, day];
}

/** Tanggal kalender valid `YYYY-MM-DD` (2000..2200; 30 Feb dsb. ditolak). */
export function isIsoDate(v: unknown): v is IsoDate {
  if (typeof v !== "string") return false;
  try {
    parts(v);
    return true;
  } catch {
    return false;
  }
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

function fmt(y: number, m: number, d: number): IsoDate {
  return `${pad(y, 4)}-${pad(m)}-${pad(d)}`;
}

/** Tanggal kalender WIB dari instant. */
export function jakartaDate(at: Date): IsoDate {
  return new Date(at.getTime() + WIB_OFFSET_MS).toISOString().slice(0, 10);
}

/** 00:00 WIB tanggal `d` sebagai instant (untuk kolom timestamptz). */
export function dateToTimestamp(d: IsoDate): Date {
  parts(d);
  return new Date(`${d}T00:00:00+07:00`);
}

export function timestampToDate(ts: Date | null | undefined): IsoDate | null {
  return ts ? jakartaDate(ts) : null;
}

/**
 * Tambah n bulan dengan klem akhir bulan: 31 Jan + 1 = 28/29 Feb; 29 Feb + 12 = 28 Feb. Periode berantai memakai
 * hasil sebelumnya (31 Jan → 28 Feb → 28 Mar) — disengaja: ends_at lama = starts_at baru, tanpa celah/tumpang tindih.
 */
export function addMonths(d: IsoDate, n: number): IsoDate {
  if (!Number.isInteger(n)) throw new RangeError("bulan harus bilangan bulat");
  const [y, m, day] = parts(d);
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = total - ny * 12 + 1;
  return fmt(ny, nm, Math.min(day, daysInMonth(ny, nm)));
}

export function addDays(d: IsoDate, n: number): IsoDate {
  if (!Number.isInteger(n)) throw new RangeError("hari harus bilangan bulat");
  const [y, m, day] = parts(d);
  const t = new Date(Date.UTC(y, m - 1, day) + n * 86_400_000);
  return fmt(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

/** Selisih hari kalender b − a. */
export function daysBetween(a: IsoDate, b: IsoDate): number {
  const [y1, m1, d1] = parts(a);
  const [y2, m2, d2] = parts(b);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86_400_000);
}

/** Format YYYY-MM-DD bisa dibandingkan leksikografis. */
export function isAfter(a: IsoDate, b: IsoDate): boolean {
  return a > b;
}

// ---------------------------------------------------------------------------
// Tanggal tick (TICK_NOW hanya staging, ADR 0018 D5 / Security implications)
// ---------------------------------------------------------------------------
export interface TickDateResult {
  today: IsoDate;
  /** TICK_NOW dipakai (instance staging). */
  injected: boolean;
  /** TICK_NOW diisi tetapi DIABAIKAN (bukan staging) — pemanggil mencatat peringatan. */
  ignored: boolean;
}

export function tickToday(env: { INFRA_JOBS_INSTANCE?: string | undefined; TICK_NOW?: string | undefined }, now: Date): TickDateResult {
  const real = jakartaDate(now);
  if (env.TICK_NOW === undefined || env.TICK_NOW === "") return { today: real, injected: false, ignored: false };
  if (env.INFRA_JOBS_INSTANCE !== "staging" || !isIsoDate(env.TICK_NOW)) return { today: real, injected: false, ignored: true };
  return { today: env.TICK_NOW, injected: true, ignored: false };
}

// ---------------------------------------------------------------------------
// Transisi otomatis (subscription_tick)
// ---------------------------------------------------------------------------
export interface SubscriptionSnapshot {
  status: SubscriptionStatus;
  warrantyUntil: IsoDate | null;
  /** current_period_start (WIB). */
  startsAt: IsoDate | null;
  /** current_period_end (WIB). */
  endsAt: IsoDate | null;
  graceUntil: IsoDate | null;
  /** plans.billing_period_months (> 0). */
  periodMonths: number;
}

export type Transition =
  | {
      from: "warranty";
      to: "active";
      startsAt: IsoDate;
      endsAt: IsoDate;
      /** Invoice maintenance pertama untuk periode ini. */
      invoicePeriod: { start: IsoDate; end: IsoDate };
    }
  | { from: "active"; to: "past_due"; graceUntil: IsoDate }
  | { from: "past_due"; to: "suspended"; enqueueSuspend: true };

export type TickAnomaly =
  | "deprecated_status"
  | "warranty_without_until"
  | "active_without_period"
  | "past_due_without_grace"
  | "invalid_period";

export interface TickPlan {
  transitions: Transition[];
  final: SubscriptionSnapshot;
  anomaly: TickAnomaly | null;
}

/**
 * Rencana transisi untuk `today` (murni). Diulang sampai titik tetap (maks. 3 langkah) agar tick yang terlambat
 * (worker mati / TICK_NOW staging) tetap menghasilkan urutan transisi yang sama seperti tick harian.
 */
export function planTransitions(s: SubscriptionSnapshot, today: IsoDate): TickPlan {
  parts(today);
  if (isDeprecatedStatus(s.status)) return { transitions: [], final: s, anomaly: "deprecated_status" };
  if (!Number.isInteger(s.periodMonths) || s.periodMonths < 1 || s.periodMonths > 36) {
    return { transitions: [], final: s, anomaly: "invalid_period" };
  }
  const transitions: Transition[] = [];
  let cur: SubscriptionSnapshot = { ...s };
  for (let i = 0; i < 3; i++) {
    switch (cur.status) {
      case "warranty": {
        if (!cur.warrantyUntil) return { transitions, final: cur, anomaly: "warranty_without_until" };
        if (!isAfter(today, cur.warrantyUntil)) return { transitions, final: cur, anomaly: null };
        const startsAt = cur.warrantyUntil;
        const endsAt = addMonths(startsAt, cur.periodMonths);
        transitions.push({ from: "warranty", to: "active", startsAt, endsAt, invoicePeriod: { start: startsAt, end: endsAt } });
        cur = { ...cur, status: "active", startsAt, endsAt, graceUntil: null };
        break;
      }
      case "active": {
        if (!cur.endsAt) return { transitions, final: cur, anomaly: "active_without_period" };
        if (!isAfter(today, cur.endsAt)) return { transitions, final: cur, anomaly: null };
        const graceUntil = addMonths(cur.endsAt, GRACE_MONTHS);
        transitions.push({ from: "active", to: "past_due", graceUntil });
        cur = { ...cur, status: "past_due", graceUntil };
        break;
      }
      case "past_due": {
        if (!cur.graceUntil) return { transitions, final: cur, anomaly: "past_due_without_grace" };
        if (!isAfter(today, cur.graceUntil)) return { transitions, final: cur, anomaly: null };
        transitions.push({ from: "past_due", to: "suspended", enqueueSuspend: true });
        cur = { ...cur, status: "suspended" };
        break;
      }
      // implementation/warranty-sebelum-habis/suspended/terminated: tidak ada transisi otomatis.
      default:
        return { transitions, final: cur, anomaly: null };
    }
  }
  return { transitions, final: cur, anomaly: null };
}

// ---------------------------------------------------------------------------
// Go-live & pembayaran
// ---------------------------------------------------------------------------
export function planGoLive(
  s: Pick<SubscriptionSnapshot, "status">,
  goLiveAt: IsoDate,
  today: IsoDate,
): { ok: true; warrantyUntil: IsoDate } | { ok: false; reason: "billing_status" | "future_date" } {
  if (s.status !== "implementation") return { ok: false, reason: "billing_status" };
  if (isAfter(goLiveAt, today)) return { ok: false, reason: "future_date" };
  return { ok: true, warrantyUntil: addMonths(goLiveAt, WARRANTY_MONTHS) };
}

export type PaymentPlan =
  /** Invoice implementasi, atau subscription tanpa periode tagih (implementasi/garansi/terminated/usang): catat lunas saja. */
  | { kind: "record_only" }
  | {
      kind: "extend";
      from: "active" | "past_due" | "suspended";
      startsAt: IsoDate;
      endsAt: IsoDate;
      /** Status sebelumnya suspended → enqueue tenant_resume. */
      resume: boolean;
      /** Invoice maintenance periode berikutnya (diterbitkan bila harga plan ada). */
      nextInvoicePeriod: { start: IsoDate; end: IsoDate };
    };

/**
 * Invoice maintenance lunas (ADR 0018 D4 baris past_due/suspended → active): ends_at + satu periode, starts_at = ends
 * lama, status active, grace dihapus. Berlaku juga saat `active` (bayar di muka). Satu invoice hanya bisa lunas sekali,
 * jadi perpanjangan tidak berlipat.
 */
export function planPayment(
  s: Pick<SubscriptionSnapshot, "status" | "endsAt" | "periodMonths"> | null,
  invoiceKind: "implementation" | "maintenance",
): PaymentPlan {
  if (!s || invoiceKind !== "maintenance") return { kind: "record_only" };
  if (s.status !== "active" && s.status !== "past_due" && s.status !== "suspended") return { kind: "record_only" };
  if (!s.endsAt || !Number.isInteger(s.periodMonths) || s.periodMonths < 1) return { kind: "record_only" };
  const startsAt = s.endsAt;
  const endsAt = addMonths(startsAt, s.periodMonths);
  return { kind: "extend", from: s.status, startsAt, endsAt, resume: s.status === "suspended", nextInvoicePeriod: { start: startsAt, end: endsAt } };
}

// ---------------------------------------------------------------------------
// Pengingat email (ADR 0018 D8): H-14 sebelum garansi berakhir; H+0/H+14/H+45 setelah ends_at.
// ---------------------------------------------------------------------------
export const REMINDER_KINDS = ["warranty_h14", "due_h0", "due_h14", "due_h45"] as const;
export type ReminderKind = (typeof REMINDER_KINDS)[number];

const DUE_OFFSETS: readonly [ReminderKind, number][] = [
  ["due_h45", 45],
  ["due_h14", 14],
  ["due_h0", 0],
];

export interface DueReminder {
  kind: ReminderKind;
  /** Tanggal acuan (warranty_until / ends_at) — bagian kunci idempotensi. */
  period: IsoDate;
}

/**
 * Pengingat yang jatuh tempo hari ini (murni). Hanya SATU (yang terbaru) — bila tick terlambat beberapa hari, pengingat
 * yang terlewat tidak dikirim beruntun. Idempotensi per (subscription, kind, period) dijaga notification_log.
 * Pembayaran memajukan ends_at → kunci periode baru → pengingat periode lama tidak lagi relevan.
 */
export function dueReminder(s: SubscriptionSnapshot, today: IsoDate): DueReminder | null {
  if (s.status === "warranty") {
    if (!s.warrantyUntil) return null;
    const from = addDays(s.warrantyUntil, -14);
    if (!isAfter(from, today) && !isAfter(today, s.warrantyUntil)) return { kind: "warranty_h14", period: s.warrantyUntil };
    return null;
  }
  if (s.status === "active" || s.status === "past_due" || s.status === "suspended") {
    if (!s.endsAt) return null;
    for (const [kind, off] of DUE_OFFSETS) {
      if (!isAfter(addDays(s.endsAt, off), today)) return { kind, period: s.endsAt };
    }
  }
  return null;
}

/** Kunci notification_log (regex CHECK `^[a-z0-9_:./-]{3,200}$`). */
export function reminderKey(subscriptionId: string, r: DueReminder): string {
  return `reminder:${subscriptionId}:${r.kind}:${r.period}`;
}

/** Sidik himpunan tenant tanpa admin (16 hex sha256 id terurut); himpunan kosong = `none`. */
export function adminSetFingerprint(clientIds: readonly string[]): string {
  if (clientIds.length === 0) return "none";
  return createHash("sha256").update([...new Set(clientIds)].sort().join(","), "utf8").digest("hex").slice(0, 16);
}

/**
 * Kunci notification_log cek tenant-admin: `admin_check:<tanggal>:<sidik>` (keputusan Lead integrasi Fase 1 — email ke
 * billing HANYA bila himpunan tenant tanpa admin berubah dibanding notifikasi terakhir; audit tetap harian).
 */
export function adminCheckKey(today: IsoDate, fingerprint: string): string {
  return `admin_check:${today}:${fingerprint}`;
}

/** Sidik dari kunci notifikasi terakhir (null = kunci format lama/tidak dikenal). */
export function fingerprintFromAdminKey(key: string): string | null {
  const m = /^admin_check:[0-9]{4}-[0-9]{2}-[0-9]{2}:([0-9a-f]{16}|none)$/.exec(key);
  return m ? m[1]! : null;
}

/**
 * Keputusan cek tenant-admin (murni): `email` = kirim laporan ke billing; `mark` = catat himpunan kosong (tanpa
 * email) agar munculnya kembali tenant yang sama dianggap perubahan; `none` = himpunan sama dengan notifikasi
 * terakhir. Tanpa notifikasi sebelumnya = sidik `none`.
 */
export function adminNotifyDecision(currentFingerprint: string, lastFingerprint: string | null): "email" | "mark" | "none" {
  const last = lastFingerprint ?? "none";
  if (currentFingerprint === last) return "none";
  return currentFingerprint === "none" ? "mark" : "email";
}

// ---------------------------------------------------------------------------
// Nomor invoice `INV/YYYY/MM/NNNN` (urut per bulan terbit WIB; dialokasikan di bawah advisory lock).
// ---------------------------------------------------------------------------
export const INVOICE_NUMBER_REGEX = /^INV\/[0-9]{4}\/(0[1-9]|1[0-2])\/[0-9]{4,6}$/;

export function invoicePrefix(issueDate: IsoDate): string {
  const [y, m] = parts(issueDate);
  return `INV/${pad(y, 4)}/${pad(m)}/`;
}

export function formatInvoiceNumber(issueDate: IsoDate, seq: number): string {
  if (!Number.isInteger(seq) || seq < 1 || seq > 999_999) throw new RangeError("nomor urut invoice di luar batas");
  return `${invoicePrefix(issueDate)}${pad(seq, 4)}`;
}

/** Nomor urut berikutnya dari nomor yang sudah ada dengan prefiks sama (nomor asing diabaikan). */
export function nextInvoiceSeq(existing: readonly string[], prefix: string): number {
  let max = 0;
  for (const n of existing) {
    if (!n.startsWith(prefix) || !INVOICE_NUMBER_REGEX.test(n)) continue;
    const seq = Number(n.slice(prefix.length));
    if (seq > max) max = seq;
  }
  return max + 1;
}

// ---------------------------------------------------------------------------
// Uang
// ---------------------------------------------------------------------------
/** Nominal dari form: angka desimal ≤ 12 digit + ≤ 2 desimal, tanpa pemisah ribuan. */
export const AMOUNT_REGEX = /^(0|[1-9][0-9]{0,11})(\.[0-9]{1,2})?$/;

/** Nominal > 0 (QA N4, keputusan Lead: tidak ada invoice/harga nol di Fase 1). */
export function isPositiveAmount(v: string | null | undefined): v is string {
  return typeof v === "string" && AMOUNT_REGEX.test(v) && /[1-9]/.test(v);
}

/** Kode mata uang ISO 4217 (huruf besar) — override harga langganan. */
export const CURRENCY_REGEX = /^[A-Z]{3}$/;

export interface PriceSources {
  /** Override per langganan (subscriptions.price_amount/price_currency) — keputusan Lead integrasi Fase 1. */
  subscriptionPrice: string | null;
  subscriptionCurrency: string | null;
  planPrice: string | null;
  planCurrency: string;
}

/**
 * Harga invoice maintenance otomatis: override langganan bila ada, selain itu harga plan; keduanya NULL → null
 * (pemanggil melewati penerbitan dan mencatat `price_missing` di audit).
 */
export function effectivePrice(p: PriceSources): { amount: string; currency: string; source: "subscription" | "plan" } | null {
  if (p.subscriptionPrice !== null && isPositiveAmount(p.subscriptionPrice)) {
    return { amount: p.subscriptionPrice, currency: p.subscriptionCurrency ?? p.planCurrency, source: "subscription" };
  }
  // Harga plan 0 (CHECK plans hanya ≥ 0) diperlakukan "belum ditetapkan" — tidak ada invoice nol (QA N4).
  if (p.planPrice !== null && isPositiveAmount(p.planPrice)) return { amount: p.planPrice, currency: p.planCurrency, source: "plan" };
  return null;
}

export function formatAmount(amount: string | null, currency = "IDR"): string {
  if (amount === null) return "—";
  const [int, frac] = amount.split(".");
  const grouped = (int ?? "0").replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  const dec = frac && /[1-9]/.test(frac) ? `,${frac.padEnd(2, "0")}` : "";
  return `${currency} ${grouped}${dec}`;
}

// ---------------------------------------------------------------------------
// Email (teks polos, tanpa HTML) — komposisi murni.
// ---------------------------------------------------------------------------
/** Satu baris tanpa karakter kontrol (subject/header-safe), dipotong. */
export function oneLine(v: string, max = 120): string {
  return v.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

export interface ReminderContext {
  tenantName: string;
  slug: string;
  planName: string;
  status: SubscriptionStatus;
  /** Invoice maintenance terbuka terakhir (bila ada). */
  invoice: { number: string; amount: string | null; currency: string } | null;
  graceUntil: IsoDate | null;
  billingEmail: string;
}

export function composeReminder(r: DueReminder, c: ReminderContext): { subject: string; text: string } {
  const tenant = oneLine(c.tenantName, 80);
  const plan = oneLine(c.planName, 80);
  const inv = c.invoice
    ? `Invoice: ${c.invoice.number} (${formatAmount(c.invoice.amount, c.invoice.currency)})`
    : "Invoice: akan dikirim terpisah oleh tim billing.";
  const footer = [
    "",
    "Pembayaran melalui transfer bank; kirim bukti transfer ke " + c.billingEmail + ".",
    "Email ini dikirim otomatis oleh control plane — mohon tidak membalas ke alamat pengirim.",
  ];
  switch (r.kind) {
    case "warranty_h14":
      return {
        subject: oneLine(`Masa garansi ${tenant} (${plan}) berakhir ${r.period}`),
        text: [
          `Yth. admin ${tenant},`,
          "",
          `Masa garansi layanan ${plan} (${c.slug}) berakhir pada ${r.period}.`,
          "Setelah tanggal tersebut layanan berlanjut ke masa maintenance bulanan dan invoice maintenance pertama akan diterbitkan.",
          ...footer,
        ].join("\n"),
      };
    case "due_h0":
      return {
        subject: oneLine(`Tagihan maintenance ${tenant} (${plan}) jatuh tempo ${r.period}`),
        text: [
          `Yth. admin ${tenant},`,
          "",
          `Periode maintenance layanan ${plan} (${c.slug}) berakhir hari ini (${r.period}).`,
          inv,
          "Mohon lakukan pembayaran agar layanan tetap aktif.",
          ...footer,
        ].join("\n"),
      };
    case "due_h14":
    case "due_h45":
      return {
        subject: oneLine(
          `${r.kind === "due_h45" ? "Peringatan akhir" : "Pengingat"}: tagihan ${tenant} (${plan}) lewat jatuh tempo sejak ${r.period}`,
        ),
        text: [
          `Yth. admin ${tenant},`,
          "",
          `Tagihan maintenance layanan ${plan} (${c.slug}) belum kami terima sejak ${r.period}.`,
          inv,
          c.graceUntil
            ? `Bila belum lunas sampai ${c.graceUntil}, layanan akan ditangguhkan sementara (data tetap aman).`
            : "Layanan dapat ditangguhkan sementara bila tagihan belum lunas (data tetap aman).",
          ...footer,
        ].join("\n"),
      };
  }
}

export function composeAdminReport(today: IsoDate, slugs: readonly string[]): { subject: string; text: string } {
  return {
    subject: oneLine(`[control-plane] ${slugs.length} tenant tanpa tenant-admin (${today})`),
    text: [
      `Cek harian ${today}: tenant berikut tidak punya tenant-admin (client_admin) berstatus invited/active.`,
      "Tambahkan tenant-admin lewat halaman Users (ADR 0018 D3).",
      "",
      ...slugs.map((s) => `- ${s}`),
    ].join("\n"),
  };
}

/** Tenant non-platform aktif tanpa tenant-admin invited/active (murni). */
export function tenantsWithoutAdmin(
  tenants: readonly { id: string; slug: string; isPlatform: boolean; status: string; terminatedAt: Date | null }[],
  adminClientIds: ReadonlySet<string>,
): { id: string; slug: string }[] {
  return tenants
    .filter((t) => !t.isPlatform && t.status !== "terminated" && t.terminatedAt === null && !adminClientIds.has(t.id))
    .map((t) => ({ id: t.id, slug: t.slug }));
}
