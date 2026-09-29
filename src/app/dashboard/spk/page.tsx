import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { datamartEnabled } from "@/db/datamart";
import { requirePermission } from "@/lib/authz";
import { rupiah, rupiahCompact, stageTone, tanggal, tanggalJam } from "@/lib/format";
import { parseSpkListParams, spkQuery } from "@/lib/spk-params";
import { accessFor, getSpkDashboard, listAccess } from "@/server/spk-dashboard";
import { Nav } from "../../nav";
import { Progress, StageBar, ValueBar } from "./bars";

/**
 * Dashboard SPK per client (ADR 0016). Akses & hak nilai dari grup Odoo (mart_user_access, RLS per sub);
 * isolasi client = RLS app.client. Server component tanpa JS klien: filter = form GET, No SPK = link detail.
 */
export default async function SpkDashboardPage(props: PageProps<"/dashboard/spk">) {
  const session = await requirePermission("dashboard:view");
  const sub = session.user?.id;
  if (!datamartEnabled() || !sub) notFound();
  const p = parseSpkListParams(await props.searchParams);
  if (!p.client) {
    const all = await listAccess(sub);
    const only = all.length === 1 ? all[0] : undefined;
    if (only) redirect(`/dashboard/spk${spkQuery({ ...p, client: only.client })}`);
    redirect("/dashboard");
  }
  const access = await accessFor(sub, p.client);
  if (!access) redirect("/forbidden");
  const d = await getSpkDashboard(sub, access, p);
  const pages = Math.max(1, Math.ceil(d.total / p.pageSize));
  const maxCustomer = Math.max(1, ...(d.valueByCustomer ?? []).map((c) => c.value));

  return (
    <>
      <Nav session={session} />
      <main className="space-y-4 p-4 sm:p-6">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h1 className="text-lg font-semibold">Dashboard SPK · {access.client}</h1>
            <p className="text-sm text-slate-600">
              {access.canSeeValue ? "Tampilan Owner/Finance — status dan nilai proyek" : "Tampilan status pengerjaan"}
              {" · "}data diperbarui {tanggalJam(d.refreshedAt)} WIB (tiap 30 menit)
            </p>
          </div>
        </div>

        <form method="get" className="flex flex-wrap gap-2 text-sm">
          <input type="hidden" name="client" value={access.client} />
          <input name="q" defaultValue={p.q} maxLength={60} placeholder="Cari no SPK, no lama, klien, brand, AE"
            className="w-72 rounded border px-2 py-1" />
          <select name="status" defaultValue={p.status} className="rounded border px-2 py-1">
            <option value="spk">SPK</option>
            <option value="penawaran">Penawaran</option>
            <option value="">Semua</option>
          </select>
          <select name="stage" defaultValue={p.stage} className="rounded border px-2 py-1">
            <option value="">Semua tahap</option>
            {d.stages.map((s) => (
              <option key={s.stage} value={s.stage}>{s.stage}</option>
            ))}
          </select>
          <select name="sort" defaultValue={p.sort} className="rounded border px-2 py-1">
            <option value="date_desc">Terbaru</option>
            <option value="date_asc">Terlama</option>
            <option value="stage_asc">Tahap paling awal</option>
            <option value="last_desc">Update terakhir</option>
            {access.canSeeValue ? <option value="value_desc">Nilai terbesar</option> : null}
          </select>
          <button type="submit" className="rounded border bg-white px-3 py-1 hover:bg-slate-100">Terapkan</button>
          <Link href={`/dashboard/spk?client=${access.client}`} className="px-2 py-1 text-slate-600 underline">Reset</Link>
        </form>

        <section className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">
          <Kpi label="SPK" value={d.kpi.spk} sub={`${d.kpi.locations} lokasi`} />
          <Kpi label="Penawaran" value={d.kpi.quotations} sub="belum dikonfirmasi" />
          <Kpi label="Dalam proses" value={d.kpi.inProgress} tone="border-l-blue-500" />
          <Kpi label="Menunggu BAST" value={d.kpi.waitingBast} sub="laporan sudah" tone="border-l-amber-500" />
          <Kpi label="Selesai (BAST)" value={d.kpi.done} tone="border-l-emerald-500" />
          {d.value ? (
            <Kpi label="Nilai SPK" value={rupiahCompact(d.value.total)} title={rupiah(d.value.total)}
              sub={`ditagih ${rupiahCompact(d.value.invoiced)} · piutang ${rupiahCompact(d.value.due)}`}
              badge={d.value.isMockup ? "mockup" : undefined} />
          ) : null}
        </section>

        <section className="rounded border bg-white p-3">
          <div className="mb-2 text-sm font-medium">Tahap SPK <span className="font-normal text-slate-500">(lokasi paling tertinggal)</span></div>
          <StageBar stages={d.stages.map((s) => ({
            stage: s.stage, count: s.count, active: p.stage === s.stage,
            href: `/dashboard/spk${spkQuery(p, { stage: p.stage === s.stage ? "" : s.stage, page: 1 })}`,
          }))} />
          <div className="mt-2 flex flex-wrap gap-3 text-xs">
            {d.stages.map((s) => (
              <Link key={s.stage} href={`/dashboard/spk${spkQuery(p, { stage: p.stage === s.stage ? "" : s.stage, page: 1 })}`}
                className={p.stage === s.stage ? "font-bold" : ""}>
                <span className={`mr-1 inline-block rounded px-1.5 ${stageTone(s.stage)}`}>{s.stage}</span>{s.count}
              </Link>
            ))}
          </div>
        </section>

        {d.value && d.valueByCustomer ? (
          <section className="rounded border bg-white p-3">
            <div className="mb-2 text-sm font-medium">Nilai per klien (8 teratas)</div>
            <div className="grid gap-1 md:grid-cols-2">
              {d.valueByCustomer.map((c) => (
                <div key={c.customer} className="flex items-center gap-2 text-sm">
                  <span className="w-40 truncate" title={c.customer}>{c.customer}</span>
                  <span className="flex-1"><ValueBar value={c.value} max={maxCustomer} label={c.customer} /></span>
                  <span className="w-24 text-right" title={rupiah(c.value)}>{rupiahCompact(c.value)}</span>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        <section className="overflow-x-auto rounded border bg-white">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-100">
              <tr>
                <th className="p-2">No SPK</th>
                <th className="p-2">Klien / Brand</th>
                <th className="hidden p-2 lg:table-cell">AE</th>
                <th className="p-2 text-center">Lokasi</th>
                <th className="p-2">Tahap</th>
                <th className="p-2">Status terakhir</th>
                <th className="hidden p-2 text-right xl:table-cell">Jam kru</th>
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
                    <div className="text-xs text-slate-500">{r.legacyRef ? `No lama ${r.legacyRef} · ` : ""}{tanggal(r.dateOrder)}</div>
                  </td>
                  <td className="p-2"><div>{r.customer ?? "-"}</div><div className="text-xs text-slate-500">{r.brand}</div></td>
                  <td className="hidden p-2 lg:table-cell">{r.ae ?? "-"}</td>
                  <td className="p-2 text-center">{r.locations}</td>
                  <td className="p-2">
                    <span className={`rounded px-1.5 text-xs ${stageTone(r.stage)}`}>{r.stage}</span>
                    <Progress value={r.progress} />
                  </td>
                  <td className="p-2"><div className="max-w-xs">{r.lastStatus ?? "-"}</div><div className="text-xs text-slate-500">{tanggal(r.lastStatusAt)}</div></td>
                  <td className="hidden p-2 text-right xl:table-cell">{r.crewHours.toLocaleString("id-ID")}</td>
                  {access.canSeeValue ? (
                    <td className="whitespace-nowrap p-2 text-right">
                      {rupiah(r.value)}{r.isMockup ? <span className="ml-1 rounded bg-amber-100 px-1 text-xs text-amber-800" title="Nilai mockup">m</span> : null}
                      <div className="text-xs text-slate-500">piutang {rupiah(r.due)}</div>
                    </td>
                  ) : null}
                </tr>
              ))}
              {d.rows.length === 0 ? (
                <tr><td colSpan={8} className="p-6 text-center text-slate-500">Tidak ada SPK untuk filter ini</td></tr>
              ) : null}
            </tbody>
          </table>
        </section>

        <nav className="flex items-center justify-between text-sm text-slate-600">
          <span>{d.total} data · halaman {p.page} dari {pages}</span>
          <span className="flex gap-2">
            {p.page > 1 ? <Link className="rounded border bg-white px-2 py-1" href={`/dashboard/spk${spkQuery(p, { page: p.page - 1 })}`}>Sebelumnya</Link> : null}
            {p.page < pages ? <Link className="rounded border bg-white px-2 py-1" href={`/dashboard/spk${spkQuery(p, { page: p.page + 1 })}`}>Berikutnya</Link> : null}
          </span>
        </nav>
      </main>
    </>
  );
}

function Kpi(props: { label: string; value: number | string; sub?: string; tone?: string; title?: string; badge?: string }) {
  return (
    <div className={`rounded border border-l-4 bg-white p-3 ${props.tone ?? "border-l-slate-400"}`} title={props.title}>
      <div className="text-xs text-slate-500">
        {props.label}
        {props.badge ? <span className="ml-1 rounded bg-amber-100 px-1 text-amber-800">{props.badge}</span> : null}
      </div>
      <div className="text-xl font-bold">{typeof props.value === "number" ? props.value.toLocaleString("id-ID") : props.value}</div>
      {props.sub ? <div className="text-xs text-slate-500">{props.sub}</div> : null}
    </div>
  );
}
