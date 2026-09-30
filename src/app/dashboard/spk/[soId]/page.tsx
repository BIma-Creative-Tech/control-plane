import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { datamartEnabled } from "@/db/datamart";
import { requirePermission } from "@/lib/authz";
import {
  ACTIVITY_LABEL, PAYMENT_STATE_LABEL, SCM_KIND_LABEL, SCM_STATE_LABEL, TRACK_LABEL, rupiah, scmTone, stageTone, tanggal,
  tanggalJam,
} from "@/lib/format";
import { parseSpkListParams } from "@/lib/spk-params";
import { accessFor, getSpkDetail } from "@/server/spk-dashboard";
import { Nav } from "../../../nav";
import { Progress } from "../bars";

/** Detail satu SPK: tahap per lokasi, status terakhir, kegiatan lapangan & kru; nilai hanya untuk yang berhak. */
export default async function SpkDetailPage(props: PageProps<"/dashboard/spk/[soId]">) {
  const session = await requirePermission("dashboard:view");
  const sub = session.user?.id;
  if (!datamartEnabled() || !sub) notFound();
  const { soId: raw } = await props.params;
  const soId = Number(raw);
  if (!Number.isInteger(soId) || soId <= 0 || soId > 2_147_483_647) notFound();
  const p = parseSpkListParams(await props.searchParams);
  if (!p.client) redirect("/dashboard");
  const access = await accessFor(sub, p.client);
  if (!access) redirect("/forbidden");
  const d = await getSpkDetail(sub, access, soId);
  if (!d) notFound();
  const s = d.spk;

  return (
    <>
      <Nav session={session} />
      <main className="space-y-4 p-4 sm:p-6">
        <div className="flex gap-4 text-sm">
          <Link href={`/dashboard/quotation?client=${access.client}`} className="text-blue-700 underline">← Quotation Tracker</Link>
          <Link href={`/dashboard/spk?client=${access.client}`} className="text-blue-700 underline">Dashboard SPK</Link>
        </div>
        <section className="rounded border bg-white p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h1 className="text-xl font-semibold">{s.spkNo}</h1>
              <div className="text-sm text-slate-600">
                {s.customer ?? "-"}{s.brand ? ` · ${s.brand}` : ""} · AE {s.ae ?? "-"} · {tanggal(s.dateOrder)}
              </div>
              <div className="text-xs text-slate-500">
                {s.quotationName ? `Penawaran ${s.quotationName}` : ""}{s.legacyRef ? ` · No lama ${s.legacyRef}` : ""}
              </div>
            </div>
            <div className="text-right">
              <span className="mr-1 rounded bg-slate-900 px-2 py-0.5 text-sm text-white">{TRACK_LABEL[d.track] ?? d.track}</span>
              <span className={`rounded px-2 py-0.5 text-sm ${stageTone(s.stage)}`}>{s.stage}</span>
              <Progress value={s.progress} />
            </div>
          </div>
          <div className="mt-3 rounded bg-slate-50 p-2 text-sm">
            <span className="text-slate-500">Status terakhir: </span>
            <span className="font-medium">{s.lastStatus ?? "-"}</span>
            <span className="text-slate-500"> · {tanggalJam(s.lastStatusAt)}</span>
          </div>
          {access.canSeeValue ? (
            <dl className="mt-3 grid grid-cols-2 gap-2 text-sm md:grid-cols-4">
              <Amount label="Nilai SPK" value={s.value} mockup={s.isMockup} />
              <Amount label="Sudah ditagih" value={s.invoiced} />
              <Amount label="Sudah dibayar" value={s.paid} />
              <Amount label="Piutang" value={s.due} />
            </dl>
          ) : null}
        </section>

        <section className="overflow-x-auto rounded border bg-white">
          <h2 className="border-b p-3 font-medium">Penagihan ({d.invoices.length})</h2>
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-100">
              <tr>
                <th className="p-2">No invoice</th><th className="p-2">Tanggal</th><th className="p-2">Jatuh tempo</th>
                <th className="p-2">Status bayar</th>
                {access.canSeeValue ? <><th className="p-2 text-right">Total</th><th className="p-2 text-right">Sisa</th></> : null}
              </tr>
            </thead>
            <tbody>
              {d.invoices.map((i) => (
                <tr key={i.invoiceId} className="border-t align-top">
                  <td className="p-2">
                    {i.invoiceNo}
                    {i.isRefund ? <span className="ml-1 rounded bg-rose-100 px-1 text-xs text-rose-800">refund</span> : null}
                    {i.state === "draft" ? <span className="ml-1 rounded bg-slate-200 px-1 text-xs">draft</span> : null}
                  </td>
                  <td className="p-2">{tanggal(i.invoiceDate)}</td>
                  <td className={`p-2 ${i.isOverdue ? "font-medium text-rose-700" : ""}`}>
                    {tanggal(i.dueDate)}{i.isOverdue ? " · lewat" : ""}
                  </td>
                  <td className="p-2">{i.paymentState ? PAYMENT_STATE_LABEL[i.paymentState] ?? i.paymentState : "-"}</td>
                  {access.canSeeValue ? (
                    <>
                      <td className="p-2 text-right">{rupiah(i.amountTotal)}</td>
                      <td className="p-2 text-right">{rupiah(i.residual)}</td>
                    </>
                  ) : null}
                </tr>
              ))}
              {d.invoices.length === 0 ? (
                <tr><td colSpan={6} className="p-4 text-center text-slate-500">Belum ada invoice</td></tr>
              ) : null}
            </tbody>
          </table>
        </section>

        {d.payments ? (
          <section className="overflow-x-auto rounded border bg-white">
            <h2 className="border-b p-3 font-medium">Pembayaran ({d.payments.length})</h2>
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-100">
                <tr>
                  <th className="p-2">Tanggal</th><th className="p-2">No pembayaran</th><th className="p-2">Untuk invoice</th>
                  <th className="p-2">Jurnal / memo</th><th className="p-2 text-right">Jumlah</th>
                </tr>
              </thead>
              <tbody>
                {d.payments.map((x) => (
                  <tr key={`${x.paymentId}-${x.invoiceNo}`} className="border-t align-top">
                    <td className="whitespace-nowrap p-2">{tanggal(x.date)}</td>
                    <td className="p-2">{x.paymentNo ?? "-"}</td>
                    <td className="p-2">{x.invoiceNo}</td>
                    <td className="p-2">{x.journal ?? "-"}<div className="text-xs text-slate-500">{x.memo}</div></td>
                    <td className="p-2 text-right">{rupiah(x.amount)}</td>
                  </tr>
                ))}
                {d.payments.length === 0 ? (
                  <tr><td colSpan={5} className="p-4 text-center text-slate-500">Belum ada pembayaran</td></tr>
                ) : null}
              </tbody>
            </table>
          </section>
        ) : null}

        <section className="overflow-x-auto rounded border bg-white">
          <h2 className="border-b p-3 font-medium">Pengadaan, produksi &amp; pengiriman ({d.scm.length})</h2>
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-100">
              <tr>
                <th className="p-2">Dokumen</th><th className="p-2">No</th><th className="p-2">Tanggal</th>
                <th className="p-2">Vendor / keterangan</th><th className="p-2">Status</th>
                {access.canSeeValue ? <th className="p-2 text-right">Nilai / dibayar</th> : null}
              </tr>
            </thead>
            <tbody>
              {d.scm.map((x) => (
                <tr key={`${x.kind}-${x.docId}`} className="border-t align-top">
                  <td className="p-2">{SCM_KIND_LABEL[x.kind] ?? x.kind}</td>
                  <td className="p-2">{x.docNo}</td>
                  <td className="whitespace-nowrap p-2">{tanggal(x.date)}</td>
                  <td className="p-2">
                    {x.party ?? "-"}
                    {x.detail && x.kind !== "po" && x.kind !== "bill" ? <div className="text-xs text-slate-500">{x.detail}</div> : null}
                  </td>
                  <td className="p-2">
                    <span className={`rounded px-1.5 text-xs ${scmTone(x.state)}`}>{SCM_STATE_LABEL[x.state] ?? x.state}</span>
                    {x.kind === "bill" && x.detail ? <div className="text-xs text-slate-500">{PAYMENT_STATE_LABEL[x.detail] ?? x.detail}</div> : null}
                  </td>
                  {access.canSeeValue ? (
                    <td className="whitespace-nowrap p-2 text-right">
                      {x.amount === null || x.amount === undefined ? "-" : rupiah(x.amount)}
                      {x.amountPaid !== null && x.amountPaid !== undefined ? <div className="text-xs text-slate-500">dibayar {rupiah(x.amountPaid)}</div> : null}
                    </td>
                  ) : null}
                </tr>
              ))}
              {d.scm.length === 0 ? (
                <tr><td colSpan={6} className="p-4 text-center text-slate-500">Belum ada PO / produksi / surat jalan</td></tr>
              ) : null}
            </tbody>
          </table>
        </section>

        <section className="overflow-x-auto rounded border bg-white">
          <h2 className="border-b p-3 font-medium">Lokasi ({d.locations.length})</h2>
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-100">
              <tr>
                <th className="p-2">Lokasi</th><th className="p-2">Tahap</th><th className="p-2">Deadline</th>
                <th className="p-2">Kegiatan terakhir</th><th className="p-2 text-right">Kru (orang / jam)</th>
                {access.canSeeValue ? <th className="p-2 text-right">Nilai</th> : null}
              </tr>
            </thead>
            <tbody>
              {d.locations.map((l) => (
                <tr key={l.taskId} className="border-t align-top">
                  <td className="p-2">{l.location}</td>
                  <td className="p-2"><span className={`rounded px-1.5 text-xs ${stageTone(l.stage)}`}>{l.stage}</span><Progress value={l.progress} /></td>
                  <td className="p-2">{tanggal(l.deadline)}</td>
                  <td className="p-2">{l.lastActivity ?? "-"}<div className="text-xs text-slate-500">{tanggal(l.lastActivityDate)}</div></td>
                  <td className="p-2 text-right">{l.crewPeople} / {l.crewHours.toLocaleString("id-ID")}</td>
                  {access.canSeeValue ? <td className="p-2 text-right">{rupiah(l.value)}</td> : null}
                </tr>
              ))}
              {d.locations.length === 0 ? <tr><td colSpan={6} className="p-4 text-center text-slate-500">Belum ada lokasi (SPK belum dikonfirmasi)</td></tr> : null}
            </tbody>
          </table>
        </section>

        <section className="overflow-x-auto rounded border bg-white">
          <h2 className="border-b p-3 font-medium">Kegiatan lapangan & absensi kru ({d.activities.length})</h2>
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-100">
              <tr><th className="p-2">Tanggal</th><th className="p-2">Waktu</th><th className="p-2">Kegiatan</th><th className="p-2">Kru</th><th className="p-2 text-right">Jam</th></tr>
            </thead>
            <tbody>
              {d.activities.map((a, i) => (
                <tr key={`${a.date}-${a.slot}-${i}`} className="border-t align-top">
                  <td className="whitespace-nowrap p-2">{tanggal(a.date)}</td>
                  <td className="p-2 capitalize">{a.slot ?? "-"}</td>
                  <td className="p-2">{a.type ? ACTIVITY_LABEL[a.type] ?? a.type : "-"}<div className="text-xs text-slate-500">{a.description}</div></td>
                  <td className="p-2">{a.crew ?? "-"} <span className="text-xs text-slate-500">({a.people})</span></td>
                  <td className="p-2 text-right">{a.hours.toLocaleString("id-ID")}</td>
                </tr>
              ))}
              {d.activities.length === 0 ? <tr><td colSpan={5} className="p-4 text-center text-slate-500">Belum ada kegiatan tercatat</td></tr> : null}
            </tbody>
          </table>
        </section>
      </main>
    </>
  );
}

function Amount(props: { label: string; value: number | undefined; mockup?: boolean }) {
  return (
    <div className="rounded border p-2">
      <dt className="text-xs text-slate-500">
        {props.label}
        {props.mockup ? <span className="ml-1 rounded bg-amber-100 px-1 text-amber-800">mockup</span> : null}
      </dt>
      <dd className="font-semibold">{rupiah(props.value)}</dd>
    </div>
  );
}
