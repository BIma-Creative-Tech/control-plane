import { SUBSCRIPTION_STATUS_LABELS, type SubscriptionStatus } from "@/lib/billing";

/** Komponen tampilan billing (tanpa data/aksi) — dipakai /subscriptions, /invoices, dan ringkasan tenant. */

const TONE: Record<string, string> = {
  implementation: "bg-blue-100 text-blue-800",
  warranty: "bg-sky-100 text-sky-800",
  active: "bg-green-100 text-green-800",
  past_due: "bg-amber-100 text-amber-800",
  suspended: "bg-red-100 text-red-800",
  terminated: "bg-slate-200 text-slate-700",
  unpaid: "bg-amber-100 text-amber-800",
  awaiting_confirmation: "bg-blue-100 text-blue-800",
  paid: "bg-green-100 text-green-800",
  void: "bg-slate-200 text-slate-700",
};

export function BillingBadge({ value }: { value: string }) {
  const label = value in SUBSCRIPTION_STATUS_LABELS ? SUBSCRIPTION_STATUS_LABELS[value as SubscriptionStatus] : value;
  return <span className={`rounded px-1.5 py-0.5 text-xs whitespace-nowrap ${TONE[value] ?? "bg-slate-100 text-slate-700"}`}>{label}</span>;
}

export const btn = "rounded border px-3 py-1 text-sm hover:bg-slate-100 disabled:opacity-50";
export const btnDanger = "rounded border border-red-300 px-3 py-1 text-sm text-red-700 hover:bg-red-50";
export const input = "rounded border px-2 py-1 text-sm";
