"use server";

/**
 * Server Actions halaman Subscriptions (ADR 0018 D4, W5). Mutasi = `billing:manage` (superadmin); dicek ulang di
 * billing/service.ts. Tidak ada aksi infra di request HTTP.
 */
import { createSubscription, goLiveSubscription, setSubscriptionPrice, terminateSubscription } from "@/billing/service";
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
