"use server";

/**
 * Server Actions halaman Subscriptions (ADR 0018 D4, W5). Mutasi = `billing:manage` (superadmin); dicek ulang di
 * billing/service.ts. Tidak ada aksi infra di request HTTP.
 */
import {
  createSubscription,
  goLiveSubscription,
  setClientAiConsent,
  setClientWithholding,
  setSubscriptionPrice,
  terminateSubscription,
  updatePlan,
} from "@/billing/service";
import { QUOTA_METRICS, type QuotaMetric } from "@/lib/bctone-quota";
import { getDb } from "@/db";
import { handleBillingAction } from "../billing/action-handler";

export async function createSubscriptionAction(formData: FormData): Promise<void> {
  await handleBillingAction("createSubscription", "billing:manage", "/subscriptions", formData, (svc, d) =>
    createSubscription(getDb(), svc, {
      clientId: d.clientId,
      planId: d.planId,
      notes: d.notes,
      priceAmount: d.price_amount,
      priceCurrency: d.price_amount !== undefined ? (d.price_currency ?? "IDR") : undefined,
    }),
  );
}

/** Override harga per langganan (superadmin) — kosong = kembali ke harga plan. */
export async function setSubscriptionPriceAction(formData: FormData): Promise<void> {
  await handleBillingAction("setSubscriptionPrice", "billing:manage", "/subscriptions", formData, (svc, d) =>
    setSubscriptionPrice(getDb(), svc, { subscriptionId: d.subscriptionId, priceAmount: d.price_amount ?? null, priceCurrency: d.price_currency }),
  );
}

export async function goLiveAction(formData: FormData): Promise<void> {
  await handleBillingAction("goLive", "billing:manage", "/subscriptions", formData, (svc, d) =>
    goLiveSubscription(getDb(), svc, { subscriptionId: d.subscriptionId, goLiveAt: d.goLiveAt }),
  );
}

export async function terminateSubscriptionAction(formData: FormData): Promise<void> {
  await handleBillingAction("terminateSubscription", "billing:manage", "/subscriptions", formData, (svc, d) =>
    terminateSubscription(getDb(), svc, { subscriptionId: d.subscriptionId }),
  );
}

/** D-1: ubah harga/aktif/kuota paket (superadmin). */
export async function updatePlanAction(formData: FormData): Promise<void> {
  await handleBillingAction("updatePlan", "billing:manage", "/subscriptions", formData, (svc, d) => {
    const raw = d as unknown as Record<string, number | null>;
    const limits = Object.fromEntries(QUOTA_METRICS.map((m) => [m, raw[`limit_${m}`] ?? null])) as Record<QuotaMetric, number | null>;
    return updatePlan(getDb(), svc, { planId: d.planId, priceAmount: d.price_amount ?? null, isActive: d.is_active === "on", limits });
  });
}

/** D-1 / BR-17: klien badan usaha memotong PPh 23. */
export async function setClientWithholdingAction(formData: FormData): Promise<void> {
  await handleBillingAction("setClientWithholding", "billing:manage", "/subscriptions", formData, (svc, d) =>
    setClientWithholding(getDb(), svc, { clientId: d.clientId, withholdsPph23: d.withholds_pph23 === "true" }),
  );
}

/** BCTOne BR-05/06/07: consent AI tenant (dicatat hash-chain). Sementara via admin sampai Console › Privasi (US-13). */
export async function setClientAiConsentAction(formData: FormData): Promise<void> {
  await handleBillingAction("setClientAiConsent", "billing:manage", "/subscriptions", formData, (svc, d) =>
    setClientAiConsent(getDb(), svc, { clientId: d.clientId, consent: d.consent }),
  );
}
