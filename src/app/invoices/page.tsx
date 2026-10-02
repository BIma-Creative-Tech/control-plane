import Link from "next/link";
import { requirePermission } from "@/lib/authz";
import { addDays, formatAmount, isBillable, jakartaDate, type SubscriptionStatus } from "@/lib/billing";
import { ACTION_RESULT_TEXT, parseActionResult } from "@/lib/job-list-params";
import { can } from "@/lib/roles";
import { SLUG_REGEX } from "@/lib/slug";
import { INVOICE_STATUS_FILTER, listBillingTenants, listInvoices, listSubscriptions, type InvoiceStatusFilter } from "@/server/billing-queries";
import { BillingBadge, btn, btnDanger, input } from "../billing/components";
import { ResultBanner } from "../jobs/components";
import { Nav } from "../nav";
import { issueInvoiceAction, markInvoicePaidAction, voidInvoiceAction } from "./actions";

const OPEN = new Set(["unpaid", "awaiting_confirmation"]);

/**
 * Invoices (ADR 0018 D4, W5). Lihat: superadmin/ops (`billing:view`); terbitkan/void: superadmin (`billing:manage`);
 * tandai lunas (+ referensi pembayaran & bukti, tanpa upload Fase 1): superadmin/ops (`invoices:confirm`).
 */
export default async function InvoicesPage(props: PageProps<"/invoices">) {
  const session = await requirePermission("billing:view");
  const sp = await props.searchParams;
  const r = parseActionResult(sp.r);
  const rawTenant = typeof sp.tenant === "string" ? sp.tenant : "";
  const tenantParam = SLUG_REGEX.test(rawTenant) ? rawTenant : "";
  const rawStatus = typeof sp.status === "string" ? sp.status : "";
  const statusParam = (INVOICE_STATUS_FILTER as readonly string[]).includes(rawStatus) ? (rawStatus as InvoiceStatusFilter) : null;
  const canManage = can(session.roles, "billing:manage");
  const canConfirm = can(session.roles, "invoices:confirm");

  const tenants = await listBillingTenants();
  const selected = tenantParam ? (tenants.find((t) => t.slug === tenantParam) ?? null) : null;
  const [rows, subs] = await Promise.all([
    listInvoices({ clientId: selected?.id ?? null, status: statusParam }),
    selected ? listSubscriptions(selected.id) : Promise.resolve([]),
  ]);
  const today = jakartaDate(new Date());
  const selectedActive = selected !== null && selected.status !== "terminated" && selected.terminatedAt === null;
  const openSubs = subs.filter((s) => s.status !== "terminated");

  return (
    <>
      <Nav session={session} />
      <main className="space-y-6 p-6">
        <h1 className="text-lg font-semibold">Invoices</h1>
        {r ? <ResultBanner code={r} text={ACTION_RESULT_TEXT[r]} jobId={null} /> : null}

        <form method="get" className="flex flex-wrap items-center gap-2 text-sm">
          <label>
            Tenant{" "}
            <select name="tenant" defaultValue={tenantParam} className={input}>
              <option value="">semua</option>
              {tenants.map((t) => (
                <option key={t.id} value={t.slug}>
                  {t.slug}
                </option>
              ))}
            </select>
          </label>
          <label>
            Status{" "}
            <select name="status" defaultValue={statusParam ?? ""} className={input}>
              <option value="">semua</option>
              {INVOICE_STATUS_FILTER.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className={btn}>
            Filter
          </button>
          {selected ? (
            <Link href={`/subscriptions?tenant=${selected.slug}`} className="underline">
              Langganan tenant ini
            </Link>
          ) : null}
        </form>

        <table className="w-full border bg-white text-left text-sm">
          <thead className="bg-slate-100">
            <tr>
              <th className="p-2">Nomor</th>
              <th className="p-2">Tenant</th>
              <th className="p-2">Jenis</th>
              <th className="p-2">Periode</th>
              <th className="p-2">Jumlah</th>
              <th className="p-2">Status</th>
              <th className="p-2">Terbit / jatuh tempo</th>
              <th className="p-2">Pembayaran</th>
              <th className="p-2">Aksi</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={9} className="p-2 text-slate-500">
                  Belum ada invoice.
                </td>
              </tr>
            ) : (
              rows.map((i) => (
                <tr key={i.id} className="border-t align-top">
                  <td className="p-2 font-mono whitespace-nowrap">{i.number}</td>
                  <td className="p-2 font-mono">
                    <Link href={`/invoices?tenant=${i.slug}`} className="underline">
                      {i.slug}
                    </Link>
                  </td>
                  <td className="p-2">{i.kind === "implementation" ? "implementasi" : "maintenance"}</td>
                  <td className="p-2 whitespace-nowrap">{i.periodStart && i.periodEnd ? `${i.periodStart} → ${i.periodEnd}` : "—"}</td>
                  <td className="p-2 whitespace-nowrap">{formatAmount(i.amount, i.currency)}</td>
                  <td className="p-2">
                    <BillingBadge value={i.status} />
                  </td>
                  <td className="p-2 whitespace-nowrap">
                    {i.issuedAt ?? "—"} / {i.dueAt ?? "—"}
                  </td>
                  <td className="p-2 text-xs">
                    {i.status === "paid" ? (
                      <>
                        {i.paidAt} · ref <span className="font-mono">{i.paymentReference ?? "—"}</span>
                        <br />
                        bukti: {i.proofReference ?? "—"}
                      </>
                    ) : i.status === "void" ? (
                      <>void: {i.voidReason ?? "—"}</>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="space-y-2 p-2">
                    {canConfirm && OPEN.has(i.status) ? (
                      <details>
                        <summary className="cursor-pointer text-xs underline">Tandai lunas…</summary>
                        <form action={markInvoicePaidAction} className="mt-2 flex flex-wrap items-center gap-1">
                          <input type="hidden" name="back" value={tenantParam} />
                          <input type="hidden" name="invoiceId" value={i.id} />
                          <input type="date" name="paidAt" defaultValue={today} max={today} required className={input} />
                          <input name="paymentReference" required maxLength={120} placeholder="referensi transfer" className={input} />
                          <input name="proofReference" required maxLength={200} placeholder="referensi bukti (mis. mutasi/email)" className={input} />
                          <button type="submit" className={btn}>
                            Lunas
                          </button>
                          {i.kind === "maintenance" ? (
                            <span className="w-full text-xs text-slate-500">
                              Periode langganan diperpanjang satu periode; tenant ditangguhkan → job tenant_resume.
                            </span>
                          ) : null}
                        </form>
                      </details>
                    ) : null}
                    {canManage && OPEN.has(i.status) ? (
                      <details>
                        <summary className="cursor-pointer text-xs underline">Void…</summary>
                        <form action={voidInvoiceAction} className="mt-2 flex flex-wrap items-center gap-1">
                          <input type="hidden" name="back" value={tenantParam} />
                          <input type="hidden" name="invoiceId" value={i.id} />
                          <input name="reason" required minLength={3} maxLength={500} placeholder="alasan" className={input} />
                          <button type="submit" className={btnDanger}>
                            Void
                          </button>
                        </form>
                      </details>
                    ) : null}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>

        {canManage ? (
          selected && selectedActive ? (
            <form action={issueInvoiceAction} className="flex flex-wrap items-center gap-2 rounded border bg-white p-4 text-sm">
              <span className="font-semibold">
                Terbitkan invoice untuk <span className="font-mono">{selected.slug}</span>
              </span>
              <input type="hidden" name="back" value={tenantParam} />
              <input type="hidden" name="clientId" value={selected.id} />
              <select name="kind" defaultValue="implementation" className={input}>
                <option value="implementation">implementasi</option>
                <option value="maintenance">maintenance (periode berjalan)</option>
              </select>
              <select name="subscriptionId" defaultValue="" className={input}>
                <option value="">(tanpa langganan — implementasi saja)</option>
                {openSubs.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.planCode} · {s.status}
                    {isBillable(s.status as SubscriptionStatus) && s.startsAt && s.endsAt ? ` · ${s.startsAt} → ${s.endsAt}` : ""}
                  </option>
                ))}
              </select>
              <input name="amount" required inputMode="decimal" pattern="(0|[1-9][0-9]{0,11})(\.[0-9]{1,2})?" placeholder="jumlah (IDR, mis. 1500000)" className={input} />
              <label>
                Jatuh tempo <input type="date" name="dueAt" defaultValue={addDays(today, 14)} required className={input} />
              </label>
              <button type="submit" className={btn}>
                Terbitkan
              </button>
              <p className="w-full text-xs text-slate-500">
                Nomor INV/YYYY/MM/NNNN dibuat server. Maintenance: periode = periode berjalan langganan (aktif/lewat jatuh tempo/ditangguhkan),
                satu invoice per periode.
              </p>
            </form>
          ) : (
            <p className="text-sm text-slate-500">Pilih satu tenant aktif (filter) untuk menerbitkan invoice.</p>
          )
        ) : null}
      </main>
    </>
  );
}
