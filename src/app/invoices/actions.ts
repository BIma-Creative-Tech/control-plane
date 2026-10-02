"use server";

/**
 * Server Actions halaman Invoices (ADR 0018 D4, W5): terbitkan/void = `billing:manage` (superadmin); tandai lunas =
 * `invoices:confirm` (superadmin+ops). Semua dicek ulang di billing/service.ts dan diaudit.
 */
import { issueInvoice, markInvoicePaid, voidInvoice } from "@/billing/service";
import { getDb } from "@/db";
import { handleBillingAction } from "../billing/action-handler";

export async function issueInvoiceAction(formData: FormData): Promise<void> {
  await handleBillingAction("issueInvoice", "billing:manage", "/invoices", formData, (svc, d) =>
    issueInvoice(getDb(), svc, { clientId: d.clientId, subscriptionId: d.subscriptionId, kind: d.kind, amount: d.amount, dueAt: d.dueAt }),
  );
}

export async function voidInvoiceAction(formData: FormData): Promise<void> {
  await handleBillingAction("voidInvoice", "billing:manage", "/invoices", formData, (svc, d) =>
    voidInvoice(getDb(), svc, { invoiceId: d.invoiceId, reason: d.reason }),
  );
}

export async function markInvoicePaidAction(formData: FormData): Promise<void> {
  await handleBillingAction("markInvoicePaid", "invoices:confirm", "/invoices", formData, (svc, d) =>
    markInvoicePaid(getDb(), svc, {
      invoiceId: d.invoiceId,
      paidAt: d.paidAt,
      paymentReference: d.paymentReference,
      proofReference: d.proofReference,
    }),
  );
}
