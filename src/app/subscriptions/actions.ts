"use server";

/**
 * Server Actions halaman Subscriptions (ADR 0018 D4, W5). Mutasi = `billing:manage` (superadmin); dicek ulang di
 * billing/service.ts. Tidak ada aksi infra di request HTTP.
 */
import { createSubscription, goLiveSubscription, terminateSubscription } from "@/billing/service";
import { getDb } from "@/db";
import { handleBillingAction } from "../billing/action-handler";

export async function createSubscriptionAction(formData: FormData): Promise<void> {
  await handleBillingAction("createSubscription", "billing:manage", "/subscriptions", formData, (svc, d) =>
    createSubscription(getDb(), svc, { clientId: d.clientId, planId: d.planId, notes: d.notes }),
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
