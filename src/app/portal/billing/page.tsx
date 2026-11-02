import { getDb } from "@/db";
import { portalInvoices } from "@/db/portal-queries";
import { getWebEnv } from "@/env";
import { jakartaDate } from "@/lib/billing";
import { paymentAccountLine } from "@/lib/company";
import { ACTION_RESULT_TEXT, parseActionResult } from "@/lib/job-list-params";
import { can } from "@/lib/roles";
import { requirePortal } from "@/server/portal";
import { BillingBadge } from "../../billing/components";
import { ResultBanner } from "../../jobs/components";
import { Nav } from "../../nav";
import { ScopeNotice } from "../scope-notice";
import { portalReportPaymentAction } from "./actions";

/**
 * Console › Tagihan (tenant-admin): daftar invoice (DPP, PPN, PPh 23, yang ditransfer), lapor pembayaran manual + nomor
 * bukti potong PPh 23. Data finansial hanya untuk tenant-admin (ADR 0018 §Security). Tenant dari sesi.
 */
export const dynamic = "force-dynamic";

const rp = (v: string | number | null) => (v === null ? "—" : `Rp${new Intl.NumberFormat("id-ID", { maximumFractionDigits: 0 }).format(Number(v))}`);
const KIND: Record<string, string> = { implementation: "Implementasi", maintenance: "Langganan" };
const STATUS: Record<string, string> = { unpaid: "Belum dibayar", awaiting_confirmation: "Menunggu konfirmasi", paid: "Lunas" };

export default async function PortalBillingPage(props: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { session, scope } = await requirePortal("portal:admin");
  if (scope.kind !== "ok") {
    return (
      <>
        <Nav session={session} />
        <main className="space-y-4 p-6">
          <h1 className="text-lg font-semibold">Tagihan</h1>
          <ScopeNotice scope={scope} />
        </main>
      </>
    );
  }
  const r = parseActionResult((await props.searchParams).r);
  const { invoices, withholdsPph23 } = await portalInvoices(getDb(), scope.tenant.id);
  const instructions = getWebEnv().PAYMENT_INSTRUCTIONS ?? `Transfer ke ${paymentAccountLine()}`;
  const today = jakartaDate(new Date());
  const canReport = can(session.roles, "users:manage_own");
  const input = "rounded border px-2 py-1 text-sm";
  return (
    <>
      <Nav session={session} />
      <main className="space-y-4 p-6">
        <h1 className="text-lg font-semibold">Tagihan — {scope.tenant.name}</h1>
        {r ? <ResultBanner code={r} text={ACTION_RESULT_TEXT[r]} jobId={null} /> : null}
        <p className="text-sm text-slate-600">
          Pembayaran manual lewat transfer. {instructions ? <strong>{instructions}.</strong> : null} Setelah transfer, laporkan di bawah; tim
          kami mengonfirmasi setelah dana diterima.
          {withholdsPph23 ? " Perusahaan Anda tercatat memotong PPh 23 (2%): transfer sebesar kolom \u201cDitransfer\u201d dan isi nomor bukti potong." : ""}
        </p>
        {invoices.length === 0 ? (
          <p className="text-sm text-slate-500">Belum ada tagihan.</p>
        ) : (
          <div className="space-y-3">
            {invoices.map((i) => {
              const total = i.totalAmount ?? i.amount;
              const payable = Number(total) - Number(i.pph23Amount);
              const overdue = i.status === "unpaid" && i.dueAt !== null && i.dueAt < today;
              return (
                <section key={i.id} className="rounded border bg-white p-4 text-sm" data-testid="invoice">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono font-semibold">{i.number}</span>
                    <BillingBadge value={i.status} />
                    <span className="text-xs text-slate-500">{STATUS[i.status] ?? i.status}</span>
                    {overdue ? <span className="rounded bg-red-100 px-2 py-0.5 text-xs text-red-800">Lewat jatuh tempo</span> : null}
                  </div>
                  <dl className="mt-2 grid grid-cols-[11rem_1fr] gap-y-0.5">
                    <dt className="text-slate-500">Jenis / periode</dt>
                    <dd>
                      {KIND[i.kind] ?? i.kind}
                      {i.periodStart ? ` ${i.periodStart} s.d. ${i.periodEnd}` : ""}
                    </dd>
                    <dt className="text-slate-500">Terbit / jatuh tempo</dt>
                    <dd>
                      {i.issuedAt} / {i.dueAt}
                    </dd>
                    <dt className="text-slate-500">Harga (DPP)</dt>
                    <dd className="tabular-nums">{rp(i.amount)}</dd>
                    {i.taxScheme !== "none" ? (
                      <>
                        <dt className="text-slate-500">PPN 11% (DPP nilai lain)</dt>
                        <dd className="tabular-nums">{rp(i.ppnAmount)}</dd>
                        <dt className="text-slate-500">Total tagihan</dt>
                        <dd className="tabular-nums font-medium">{rp(total)}</dd>
                      </>
                    ) : null}
                    {Number(i.pph23Amount) > 0 ? (
                      <>
                        <dt className="text-slate-500">Dipotong PPh 23 (2%)</dt>
                        <dd className="tabular-nums">−{rp(i.pph23Amount)}</dd>
                      </>
                    ) : null}
                    <dt className="text-slate-500">Ditransfer</dt>
                    <dd className="tabular-nums font-semibold">{rp(payable)}</dd>
                    {i.paidAt ? (
                      <>
                        <dt className="text-slate-500">Lunas</dt>
                        <dd>{i.paidAt}</dd>
                      </>
                    ) : null}
                    {i.status === "awaiting_confirmation" && i.proofReference ? (
                      <>
                        <dt className="text-slate-500">Laporan Anda</dt>
                        <dd className="text-xs">{i.proofReference}</dd>
                      </>
                    ) : null}
                  </dl>
                  {i.status === "unpaid" && canReport ? (
                    <form action={portalReportPaymentAction} className="mt-3 flex flex-wrap items-end gap-2 border-t pt-3">
                      <input type="hidden" name="invoiceId" value={i.id} />
                      <label className="text-xs">
                        Tanggal transfer
                        <input type="date" name="paid_on" required max={today} defaultValue={today} className={`${input} block`} />
                      </label>
                      <label className="text-xs">
                        No. referensi / berita transfer
                        <input name="bank_reference" required minLength={3} maxLength={120} className={`${input} block w-56`} />
                      </label>
                      {Number(i.pph23Amount) > 0 ? (
                        <label className="text-xs">
                          No. bukti potong PPh 23
                          <input name="pph23_reference" required={withholdsPph23} minLength={3} maxLength={120} className={`${input} block w-48`} />
                        </label>
                      ) : null}
                      <button type="submit" className="rounded bg-slate-900 px-3 py-1 text-sm font-medium text-white">
                        Laporkan pembayaran
                      </button>
                    </form>
                  ) : null}
                </section>
              );
            })}
          </div>
        )}
      </main>
    </>
  );
}
