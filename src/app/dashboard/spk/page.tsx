import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Icon } from "@/components/icon";
import { datamartEnabled } from "@/db/datamart";
import { requirePermission } from "@/lib/authz";
import { rupiah, rupiahCompact, stageTone, tanggal } from "@/lib/format";
import { parseSpkListParams, spkQuery } from "@/lib/spk-params";
import { accessFor, getSpkDashboard, listAccess } from "@/server/spk-dashboard";
import { Nav } from "../../nav";
import {
  Badge, DashboardTabs, EmptyRow, INPUT, LINK, MockupBadge, PageHeader, Pagination, Panel, ROW, StatCard, TD, TH, rise,
} from "../ui";
import { Progress, StageBar, ValueBar, stageFill } from "./bars";

/**
 * Dashboard SPK per client (ADR 0016). Akses & hak nilai dari grup Odoo (mart_user_access, RLS per sub);
 * isolasi client = RLS app.client. Server component: filter = form GET, No SPK = link detail.
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
  const stageHref = (stage: string) => `/dashboard/spk${spkQuery(p, { stage: p.stage === stage ? "" : stage, page: 1 })}`;
  const cols = access.canSeeValue ? 8 : 7;

  return (
    <>
      <Nav session={session} />
      <main className="mx-auto max-w-[1600px] space-y-5 px-4 py-6 sm:px-6">
        <PageHeader eyebrow={access.client} title="Dashboard SPK"
          subtitle={access.canSeeValue ? "Tampilan Owner/Finance — status dan nilai proyek" : "Tampilan status pengerjaan"}
          refreshedAt={d.refreshedAt} refreshNote="otomatis ±2 menit setelah ada perubahan di Odoo"
          actions={<DashboardTabs client={access.client} active="spk" />} />

        <section className={`grid grid-cols-2 gap-2.5 md:grid-cols-3 ${d.value ? "xl:grid-cols-6" : "xl:grid-cols-5"}`}>
          <StatCard index={0} label="SPK" value={d.kpi.spk} icon="clipboard-tick" sub={`${d.kpi.locations.toLocaleString("id-ID")} lokasi`} />
          <StatCard index={1} label="Penawaran" value={d.kpi.quotations} icon="document-text" sub="belum dikonfirmasi" />
          <StatCard index={2} label="Dalam proses" value={d.kpi.inProgress} icon="status-up" tone="info" sub="desain → instalasi" />
          <StatCard index={3} label="Menunggu BAST" value={d.kpi.waitingBast} icon="task-square" tone="warn" sub="laporan sudah" />
          <StatCard index={4} label="Selesai (BAST)" value={d.kpi.done} icon="tick-circle" tone="good" />
          {d.value ? (
            <StatCard index={5} label="Nilai SPK" value={rupiahCompact(d.value.total)} title={rupiah(d.value.total)} icon="wallet-money"
              sub={`ditagih ${rupiahCompact(d.value.invoiced)} · piutang ${rupiahCompact(d.value.due)}`}
              badge={d.value.isMockup ? <MockupBadge /> : undefined} />
          ) : null}
        </section>

        <div className={`grid gap-4 ${d.value && d.valueByCustomer ? "xl:grid-cols-[3fr_2fr]" : ""}`}>
          <Panel title="Tahap SPK" icon="status-up" className={rise(4)}
            aside={<span className="text-xs text-muted-foreground">lokasi paling tertinggal · klik untuk filter</span>}>
            <div className="p-4">
              <StageBar stages={d.stages.map((s) => ({ stage: s.stage, count: s.count, active: p.stage === s.stage, href: stageHref(s.stage) }))} />
              <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
                {d.stages.map((s) => (
                  <Link key={s.stage} href={stageHref(s.stage)} aria-current={p.stage === s.stage ? "true" : undefined}
                    className={`flex items-center justify-between gap-2 rounded-xl border px-3 py-2 text-sm transition-colors hover:bg-muted ${
                      p.stage === s.stage ? "border-foreground bg-muted" : ""}`}>
                    <span className="flex min-w-0 items-center gap-2">
                      <svg viewBox="0 0 10 10" className="size-2.5 shrink-0" aria-hidden="true"><rect width={10} height={10} rx={3} className={stageFill(s.stage)} /></svg>
                      <span className="truncate">{s.stage}</span>
                    </span>
                    <span className="font-semibold tabular-nums">{s.count.toLocaleString("id-ID")}</span>
                  </Link>
                ))}
              </div>
            </div>
          </Panel>

          {d.value && d.valueByCustomer ? (
            <Panel title="Nilai per klien" icon="chart-2" className={rise(5)} aside={<span className="text-xs text-muted-foreground">8 teratas</span>}>
              <ol className="space-y-2.5 p-4">
                {d.valueByCustomer.map((c, i) => (
                  <li key={c.customer} className="grid grid-cols-[1.25rem_minmax(0,9rem)_1fr_auto] items-center gap-2 text-sm">
                    <span className="text-xs tabular-nums text-muted-foreground">{i + 1}</span>
                    <span className="truncate font-medium" title={c.customer}>{c.customer}</span>
                    <ValueBar value={c.value} max={maxCustomer} label={c.customer} />
                    <span className="text-right font-semibold tabular-nums" title={rupiah(c.value)}>{rupiahCompact(c.value)}</span>
                  </li>
                ))}
              </ol>
            </Panel>
          ) : null}
        </div>

        <Panel>
          <form method="get" className="flex flex-wrap items-center gap-2 border-b p-3 text-sm">
            <input type="hidden" name="client" value={access.client} />
            <label className="relative min-w-0 flex-1 basis-64">
              <span className="sr-only">Cari</span>
              <Icon name="search-normal" className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <input name="q" defaultValue={p.q} maxLength={60} placeholder="Cari no SPK, no lama, klien, brand, AE" className={`${INPUT} w-full pl-9`} />
            </label>
            <label className="sr-only" htmlFor="status">Status</label>
            <select id="status" name="status" defaultValue={p.status} className={INPUT}>
              <option value="spk">SPK</option>
              <option value="penawaran">Penawaran</option>
              <option value="">Semua</option>
            </select>
            <label className="sr-only" htmlFor="stage">Tahap</label>
            <select id="stage" name="stage" defaultValue={p.stage} className={INPUT}>
              <option value="">Semua tahap</option>
              {d.stages.map((s) => <option key={s.stage} value={s.stage}>{s.stage}</option>)}
            </select>
            <label className="sr-only" htmlFor="sort">Urutkan</label>
            <select id="sort" name="sort" defaultValue={p.sort} className={INPUT}>
              <option value="date_desc">Terbaru</option>
              <option value="date_asc">Terlama</option>
              <option value="stage_asc">Tahap paling awal</option>
              <option value="last_desc">Update terakhir</option>
              {access.canSeeValue ? <option value="value_desc">Nilai terbesar</option> : null}
            </select>
            <button type="submit" className="inline-flex h-10 items-center gap-1.5 rounded-lg bg-primary px-4 font-semibold text-primary-foreground transition-opacity hover:opacity-90">
              <Icon name="sort" className="size-4" />Terapkan
            </button>
            <Link href={`/dashboard/spk?client=${access.client}`} className="px-2 text-muted-foreground underline underline-offset-4 hover:text-foreground">Reset</Link>
          </form>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className={TH}>No SPK</th>
                  <th className={TH}>Klien / Brand</th>
                  <th className={`hidden lg:table-cell ${TH}`}>AE</th>
                  <th className={`text-center ${TH}`}>Lokasi</th>
                  <th className={TH}>Tahap</th>
                  <th className={TH}>Status terakhir</th>
                  <th className={`hidden text-right xl:table-cell ${TH}`}>Jam kru</th>
                  {access.canSeeValue ? <th className={`text-right ${TH}`}>Nilai / Piutang</th> : null}
                </tr>
              </thead>
              <tbody>
                {d.rows.map((r) => (
                  <tr key={r.soId} className={ROW}>
                    <td className={TD}>
                      <Link href={`/dashboard/spk/${r.soId}?client=${access.client}`} className={`${LINK} whitespace-nowrap`}>{r.spkNo}</Link>
                      <div className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                        <Icon name="calendar" className="size-3.5" />{r.legacyRef ? `No lama ${r.legacyRef} · ` : ""}{tanggal(r.dateOrder)}
                      </div>
                    </td>
                    <td className={TD}><div className="font-medium">{r.customer ?? "-"}</div><div className="text-xs text-muted-foreground">{r.brand}</div></td>
                    <td className={`hidden lg:table-cell ${TD}`}>{r.ae ?? "-"}</td>
                    <td className={`text-center tabular-nums ${TD}`}>{r.locations}</td>
                    <td className={TD}><Badge tone={stageTone(r.stage)}>{r.stage}</Badge><Progress value={r.progress} /></td>
                    <td className={TD}>
                      <div className="max-w-xs">{r.lastStatus ?? "-"}</div>
                      <div className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground"><Icon name="clock" className="size-3.5" />{tanggal(r.lastStatusAt)}</div>
                    </td>
                    <td className={`hidden text-right tabular-nums xl:table-cell ${TD}`}>{r.crewHours.toLocaleString("id-ID")}</td>
                    {access.canSeeValue ? (
                      <td className={`whitespace-nowrap text-right tabular-nums ${TD}`}>
                        <span className="font-semibold">{rupiah(r.value)}</span>{r.isMockup ? <MockupBadge short /> : null}
                        <div className="text-xs text-muted-foreground">piutang {rupiah(r.due)}</div>
                      </td>
                    ) : null}
                  </tr>
                ))}
                {d.rows.length === 0 ? <EmptyRow cols={cols}>Tidak ada SPK untuk filter ini</EmptyRow> : null}
              </tbody>
            </table>
          </div>
        </Panel>

        <Pagination total={d.total} page={p.page} pages={pages}
          prev={p.page > 1 ? `/dashboard/spk${spkQuery(p, { page: p.page - 1 })}` : undefined}
          next={p.page < pages ? `/dashboard/spk${spkQuery(p, { page: p.page + 1 })}` : undefined} />
      </main>
    </>
  );
}
