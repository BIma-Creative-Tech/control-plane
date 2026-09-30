import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { datamartEnabled } from "@/db/datamart";
import { requirePermission } from "@/lib/authz";
import { TRACK_LABEL, rupiah, rupiahCompact, stageTone, tanggal, tanggalJam, trackTone } from "@/lib/format";
import { odooUrlFor } from "@/lib/odoo-links";
import { parseTrackerParams, trackerQuery } from "@/lib/spk-params";
import { getQuotationTracker } from "@/server/quotation-tracker";
import { accessFor, listAccess } from "@/server/spk-dashboard";
import { Nav } from "../../nav";
import { FunnelBar, Progress, TrackSteps } from "../spk/bars";

/**
 * Quotation Tracker (plan infra 15): Penawaran → SPK → Produksi → Absensi kru → Ditagih → Lunas per client.
 * Landing pascalogin Odoo untuk grup "Dashboard Quotation Tracker". Server component tanpa JS klien.
 */
export default async function QuotationTrackerPage(props: PageProps<"/dashboard/quotation">) {
  const session = await requirePermission("dashboard:view");
  const sub = session.user?.id;
  if (!datamartEnabled() || !sub) notFound();
  const p = parseTrackerParams(await props.searchParams);
  if (!p.client) {
    const all = await listAccess(sub);
    const only = all.length === 1 ? all[0] : undefined;
    if (only) redirect(`/dashboard/quotation${trackerQuery({ ...p, client: only.client })}`);
    redirect("/dashboard");
  }
  const access = await accessFor(sub, p.client);
  if (!access) redirect("/forbidden");
  const d = await getQuotationTracker(sub, access, p);
  const pages = Math.max(1, Math.ceil(d.total / p.pageSize));
  const top = Math.max(1, d.funnel[0]?.reached ?? 1);
  const odoo = odooUrlFor(access.client);
  const cols = access.canSeeValue ? 8 : 7;

  return (
    <>
      <Nav session={session} />
      <main className="space-y-4 p-4 sm:p-6">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h1 className="text-lg font-semibold">Quotation Tracker · {access.client}</h1>
            <p className="text-sm text-slate-600">
              Penawaran → SPK → Produksi → Absensi kru → Penagihan → Pembayaran · data diperbarui{" "}
              {tanggalJam(d.refreshedAt)} WIB (tiap 30 menit)
            </p>
          </div>
          <div className="flex gap-2 text-sm">
            <Link href={`/dashboard/spk?client=${access.client}`} className="rounded border bg-white px-3 py-1 hover:bg-slate-100">
              Dashboard SPK
            </Link>
            {odoo ? (
              <a href={`${odoo}/odoo`} className="rounded border bg-slate-900 px-3 py-1 text-white hover:bg-slate-700">
                Buka Odoo
              </a>
            ) : null}
          </div>
        </div>

        <section aria-label="Alur penawaran" className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">
          {d.funnel.map((s) => {
            const active = p.track === s.key;
            const body = (
              <>
                <div className="text-xs text-slate-500">{s.label}</div>
                <div className="text-xl font-bold">{s.reached.toLocaleString("id-ID")}</div>
                <FunnelBar value={s.reached} max={top} label={`${s.label}: ${s.reached}`} />
                <div className="mt-1 text-xs text-slate-500">
                  {s.key === "absensi"
                    ? `${d.crewHours.toLocaleString("id-ID")} jam kru`
                    : s.key === "lunas" ? "pembayaran penuh" : `${s.current.toLocaleString("id-ID")} berhenti di sini`}
                </div>
                {s.amount !== undefined ? (
                  <div className="text-xs font-medium" title={rupiah(s.amount)}>
                    {s.key === "lunas" ? "dibayar " : ""}{rupiahCompact(s.amount)}
                  </div>
                ) : null}
              </>
            );
            const cls = `block rounded border bg-white p-3 ${active ? "border-slate-900 ring-1 ring-slate-900" : ""}`;
            return s.key === "absensi" ? (
              <div key={s.key} className={cls}>{body}</div>
            ) : (
              <Link key={s.key} className={`${cls} hover:bg-slate-50`}
                href={`/dashboard/quotation${trackerQuery(p, { track: active ? "" : (s.key as typeof p.track), page: 1 })}`}>
                {body}
              </Link>
            );
          })}
        </section>

        {d.value ? (
          <section className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">
            <Amount label="Penawaran terbuka" value={d.value.quoted} mockup={d.value.isMockup} />
            <Amount label="Nilai SPK" value={d.value.spk} />
            <Amount label="Sudah ditagih" value={d.value.invoiced} />
            <Amount label="Sudah dibayar" value={d.value.paid} />
            <Amount label="Piutang" value={d.value.due} />
            <Amount label="Lewat jatuh tempo" value={d.value.overdue} warn={d.value.overdue > 0} />
          </section>
        ) : null}

        <form method="get" className="flex flex-wrap gap-2 text-sm">
          <input type="hidden" name="client" value={access.client} />
          <input name="q" defaultValue={p.q} maxLength={60} placeholder="Cari no penawaran/SPK, klien, brand, AE"
            className="w-72 rounded border px-2 py-1" />
          <select name="track" defaultValue={p.track} className="rounded border px-2 py-1">
            <option value="">Semua tahap (tanpa batal)</option>
            {Object.entries(TRACK_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <select name="sort" defaultValue={p.sort} className="rounded border px-2 py-1">
            <option value="date_desc">Terbaru</option>
            <option value="date_asc">Terlama</option>
            <option value="stage_asc">Tahap paling awal</option>
            <option value="last_desc">Update terakhir</option>
            {access.canSeeValue ? <option value="value_desc">Nilai terbesar</option> : null}
          </select>
          <button type="submit" className="rounded border bg-white px-3 py-1 hover:bg-slate-100">Terapkan</button>
          <Link href={`/dashboard/quotation?client=${access.client}`} className="px-2 py-1 text-slate-600 underline">Reset</Link>
          {d.cancelled ? <span className="px-2 py-1 text-slate-500">{d.cancelled} batal disembunyikan</span> : null}
        </form>

        <section className="overflow-x-auto rounded border bg-white">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-100">
              <tr>
                <th className="p-2">No Penawaran / SPK</th>
                <th className="p-2">Klien / Brand</th>
                <th className="p-2">Tahap</th>
                <th className="hidden p-2 md:table-cell">Produksi</th>
                <th className="hidden p-2 text-right lg:table-cell">Absensi kru</th>
                <th className="p-2">Penagihan</th>
                <th className="hidden p-2 lg:table-cell">Pembayaran</th>
                {access.canSeeValue ? <th className="p-2 text-right">Nilai / Piutang</th> : null}
              </tr>
            </thead>
            <tbody>
              {d.rows.map((r) => (
                <tr key={r.soId} className="border-t align-top hover:bg-slate-50">
                  <td className="p-2">
                    <Link href={`/dashboard/spk/${r.soId}?client=${access.client}`} className="font-semibold text-blue-700 underline">
                      {r.spkNo}
                    </Link>
                    <div className="text-xs text-slate-500">
                      {r.quotationName && r.quotationName !== r.spkNo ? `${r.quotationName} · ` : ""}{tanggal(r.dateOrder)}
                    </div>
                    <div className="text-xs text-slate-500 lg:hidden">AE {r.ae ?? "-"}</div>
                  </td>
                  <td className="p-2"><div>{r.customer ?? "-"}</div><div className="text-xs text-slate-500">{r.brand}</div></td>
                  <td className="p-2">
                    <span className={`rounded px-1.5 text-xs ${trackTone(r.track)}`}>{TRACK_LABEL[r.track] ?? r.track}</span>
                    <TrackSteps track={r.track} />
                  </td>
                  <td className="hidden p-2 md:table-cell">
                    {r.locations ? (
                      <>
                        <span className={`rounded px-1.5 text-xs ${stageTone(r.stage)}`}>{r.stage}</span>
                        <Progress value={r.progress} />
                        <div className="text-xs text-slate-500">{r.locations} lokasi</div>
                      </>
                    ) : <span className="text-slate-400">-</span>}
                  </td>
                  <td className="hidden p-2 text-right lg:table-cell">
                    {r.crewHours ? `${r.crewPeople} org · ${r.crewHours.toLocaleString("id-ID")} jam` : "-"}
                  </td>
                  <td className="p-2">
                    {r.invoiceCount ? `${r.invoiceCount} invoice` : <span className="text-slate-400">belum</span>}
                    {r.nextDueDate ? (
                      <div className={`text-xs ${r.overdue ? "font-medium text-rose-700" : "text-slate-500"}`}>
                        jatuh tempo {tanggal(r.nextDueDate)}
                      </div>
                    ) : null}
                  </td>
                  <td className="hidden p-2 lg:table-cell">
                    {r.paymentCount ? `${r.paymentCount}× bayar` : <span className="text-slate-400">belum</span>}
                    {r.lastPaymentDate ? <div className="text-xs text-slate-500">terakhir {tanggal(r.lastPaymentDate)}</div> : null}
                  </td>
                  {access.canSeeValue ? (
                    <td className="whitespace-nowrap p-2 text-right">
                      {rupiah(r.value)}{r.isMockup ? <span className="ml-1 rounded bg-amber-100 px-1 text-xs text-amber-800" title="Nilai mockup">m</span> : null}
                      <div className="text-xs text-slate-500">piutang {rupiah(r.due)}</div>
                    </td>
                  ) : null}
                </tr>
              ))}
              {d.rows.length === 0 ? (
                <tr><td colSpan={cols} className="p-6 text-center text-slate-500">Tidak ada data untuk filter ini</td></tr>
              ) : null}
            </tbody>
          </table>
        </section>

        <nav className="flex items-center justify-between text-sm text-slate-600">
          <span>{d.total} data · halaman {p.page} dari {pages}</span>
          <span className="flex gap-2">
            {p.page > 1 ? <Link className="rounded border bg-white px-2 py-1" href={`/dashboard/quotation${trackerQuery(p, { page: p.page - 1 })}`}>Sebelumnya</Link> : null}
            {p.page < pages ? <Link className="rounded border bg-white px-2 py-1" href={`/dashboard/quotation${trackerQuery(p, { page: p.page + 1 })}`}>Berikutnya</Link> : null}
          </span>
        </nav>
      </main>
    </>
  );
}

function Amount(props: { label: string; value: number; mockup?: boolean; warn?: boolean }) {
  return (
    <div className={`rounded border border-l-4 bg-white p-3 ${props.warn ? "border-l-rose-500" : "border-l-slate-400"}`} title={rupiah(props.value)}>
      <div className="text-xs text-slate-500">
        {props.label}
        {props.mockup ? <span className="ml-1 rounded bg-amber-100 px-1 text-amber-800">mockup</span> : null}
      </div>
      <div className="text-lg font-bold">{rupiahCompact(props.value)}</div>
    </div>
  );
}
