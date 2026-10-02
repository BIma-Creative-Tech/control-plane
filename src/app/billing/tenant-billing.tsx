import Link from "next/link";
import type { Session } from "next-auth";
import { formatAmount } from "@/lib/billing";
import { can } from "@/lib/roles";
import { getTenantBillingSummary } from "@/server/billing-queries";
import { BillingBadge } from "./components";

/**
 * Ringkasan billing satu tenant (read-only) untuk disematkan di halaman detail tenant (W5, halaman milik branch
 * Tenants): langganan non-terminated + invoice terbuka, dengan tautan ke /subscriptions dan /invoices (tempat aksi).
 * Tanpa izin `billing:view` → tidak merender apa pun (pemanggil tetap wajib requirePermission di page-nya).
 *
 * Pemakaian: `<TenantBillingSummary session={session} clientId={client.id} slug={client.slug} />`
 */
export async function TenantBillingSummary({ session, clientId, slug }: { session: Session; clientId: string; slug: string }) {
  if (!can(session.roles, "billing:view")) return null;
  const { subscriptions, openInvoices } = await getTenantBillingSummary(clientId);
  return (
    <section className="space-y-2 rounded border bg-white p-4 text-sm">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="font-semibold">Langganan & invoice</h2>
        <Link href={`/subscriptions?tenant=${slug}`} className="text-xs underline">
          Kelola langganan
        </Link>
        <Link href={`/invoices?tenant=${slug}`} className="text-xs underline">
          Kelola invoice
        </Link>
      </div>
      {subscriptions.length === 0 ? (
        <p className="text-slate-500">Belum ada langganan.</p>
      ) : (
        <ul className="space-y-1">
          {subscriptions.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center gap-2">
              <span className="font-mono">{s.planCode}</span>
              <BillingBadge value={s.status} />
              {s.status === "warranty" && s.warrantyUntil ? <span className="text-xs text-slate-500">garansi s.d. {s.warrantyUntil}</span> : null}
              {s.endsAt ? <span className="text-xs text-slate-500">periode s.d. {s.endsAt}</span> : null}
              {s.graceUntil ? <span className="text-xs text-amber-700">grace s.d. {s.graceUntil}</span> : null}
            </li>
          ))}
        </ul>
      )}
      <p className="text-slate-700">
        Invoice terbuka: <strong>{openInvoices.length}</strong>
        {openInvoices.length > 0
          ? ` — ${openInvoices
              .slice(0, 3)
              .map((i) => `${i.number} (${formatAmount(i.amount, i.currency)}, jatuh tempo ${i.dueAt ?? "—"})`)
              .join("; ")}`
          : ""}
      </p>
    </section>
  );
}
