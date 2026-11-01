/**
 * Form halaman Subscriptions & Invoices (ADR 0018) — Zod `.strict()` server-side, modul murni (diuji unit).
 * Field di luar skema, field berulang, atau File → ditolak. Teks bebas: tanpa karakter kontrol, panjang terbatas.
 */
import { z } from "zod";
import { CURRENCY_REGEX, isIsoDate, isPositiveAmount } from "./billing";
import { UUID_REGEX } from "./job-contract";
import { formToObject } from "./job-forms";
import { QUOTA_METRICS } from "./bctone-quota";

const uuid = z.string().regex(UUID_REGEX);
const isoDate = z.string().trim().refine(isIsoDate, "tanggal YYYY-MM-DD");
/** Teks satu baris tanpa karakter kontrol. */
const line = (min: number, max: number) =>
  z
    .string()
    .trim()
    .min(min)
    .max(max)
    .regex(/^[^\u0000-\u001f\u007f]*$/);
/** Nominal opsional: "" = tidak diisi. */
const optionalAmount = z
  .string()
  .trim()
  .transform((v) => (v === "" ? undefined : v))
  .pipe(z.string().refine(isPositiveAmount, "nominal > 0").optional())
  .optional();
const currency = z.string().trim().toUpperCase().regex(CURRENCY_REGEX);
/** Batas kuota: "" = tanpa batas (null), selain itu bilangan bulat 0..999.999.999.999. */
const optionalLimit = z
  .string()
  .trim()
  .regex(/^(|0|[1-9][0-9]{0,11})$/)
  .transform((v) => (v === "" ? null : Number(v)));
const optionalUuid = z
  .string()
  .transform((v) => (v === "" ? undefined : v))
  .pipe(uuid.optional())
  .optional();

export const billingFormSchemas = {
  createSubscription: z
    .object({
      clientId: uuid,
      planId: uuid,
      notes: z
        .string()
        .trim()
        .max(1000)
        .regex(/^[^\u0000-\u0009\u000b-\u001f\u007f]*$/)
        .transform((v) => (v === "" ? undefined : v))
        .optional(),
      /** Override harga per langganan (opsional; kosong = harga plan). */
      price_amount: optionalAmount,
      price_currency: currency.optional(),
    })
    .strict(),
  /** Ubah override harga (superadmin): kosong = hapus override (kembali ke harga plan). */
  setSubscriptionPrice: z.object({ subscriptionId: uuid, price_amount: optionalAmount, price_currency: currency.default("IDR") }).strict(),
  goLive: z.object({ subscriptionId: uuid, goLiveAt: isoDate }).strict(),
  terminateSubscription: z.object({ subscriptionId: uuid, confirm: z.literal("on") }).strict(),
  issueInvoice: z
    .object({
      clientId: uuid,
      subscriptionId: optionalUuid,
      kind: z.enum(["implementation", "maintenance"]),
      amount: z.string().trim().refine(isPositiveAmount, "nominal > 0"),
      dueAt: isoDate,
    })
    .strict(),
  voidInvoice: z.object({ invoiceId: uuid, reason: line(3, 500) }).strict(),
  /**
   * D-1: ubah paket (harga, aktif, kuota) dari form. Harga "" = belum ditetapkan (Free). limit_<metric> "" = tanpa batas.
   * Checkbox `is_active` hanya terkirim bila dicentang.
   */
  updatePlan: z
    .object({
      planId: uuid,
      price_amount: optionalAmount,
      is_active: z.literal("on").optional(),
      ...Object.fromEntries(QUOTA_METRICS.map((m) => [`limit_${m}`, optionalLimit])),
    })
    .strict(),
  setClientWithholding: z.object({ clientId: uuid, withholds_pph23: z.enum(["true", "false"]) }).strict(),
  markInvoicePaid: z
    .object({
      invoiceId: uuid,
      paidAt: isoDate,
      paymentReference: line(1, 120),
      proofReference: line(1, 200),
    })
    .strict(),
} as const;

export type BillingFormName = keyof typeof billingFormSchemas;
export type BillingFormData<N extends BillingFormName> = z.infer<(typeof billingFormSchemas)[N]>;

export function parseBillingForm<N extends BillingFormName>(
  name: N,
  entries: Iterable<[string, FormDataEntryValue]>,
): { success: true; data: BillingFormData<N> } | { success: false } {
  const obj = formToObject(entries);
  if (!obj) return { success: false };
  const r = billingFormSchemas[name].safeParse(obj);
  return r.success ? { success: true, data: r.data as BillingFormData<N> } : { success: false };
}
