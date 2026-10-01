import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Icon, type IconName } from "@/components/icon";
import { NumberTicker } from "@/components/number-ticker";
import { datamartEnabled } from "@/db/datamart";
import { requirePermission } from "@/lib/authz";
import { TRACK_LABEL, rupiah, rupiahCompact, stageTone, tanggal, trackTone } from "@/lib/format";
import { odooUrlFor } from "@/lib/odoo-links";
import { parseTrackerParams, trackerQuery } from "@/lib/spk-params";
import { getQuotationTracker } from "@/server/quotation-tracker";
import { accessFor, listAccess } from "@/server/spk-dashboard";
import { Nav } from "../../nav";
import { FunnelBar, Progress, TrackSteps } from "../spk/bars";
import {
  Badge, ButtonLink, DashboardTabs, EmptyRow, INPUT, LINK, MockupBadge, Muted, PageHeader, Pagination, Panel, ROW, TD, TH,
  rise,
} from "../ui";

/** Langkah funnel yang bukan `tracker_stage` (tidak bisa jadi filter tabel). */
const INFO_STEPS = new Set(["lead", "pengadaan", "dikirim", "absensi"]);
const STEP_NOTE: Record<string, string> = { lead: "pipeline ", pengadaan: "biaya ", lunas: "dibayar " };
const STEP_ICON: Record<string, IconName> = {
  lead: "user-tag", penawaran: "document-text", spk: "clipboard-tick", pengadaan: "shopping-cart", produksi: "3dcube",
  dikirim: "truck-fast", absensi: "people", ditagih: "receipt-2", lunas: "wallet-check",
};

/**
 * Quotation Tracker (plan infra 15/16): Lead CRM → Penawaran → SPK → Pengadaan → Produksi → Terkirim → Absensi kru
 * → Ditagih → Lunas per client.
 * Landing pascalogin Odoo untuk grup "Dashboard Quotation Tracker". Server component; satu-satunya JS klien =
 * hitung naik angka (MotionEnhancer di layout dashboard).
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
  const cols = access.canSeeValue ? 9 : 8;

  return (
    <>
      <Nav session={session} />
      <main className="mx-auto max-w-[1600px] space-y-5 px-4 py-6 sm:px-6">
        <PageHeader eyebrow={access.client} title="Quotation Tracker"
          subtitle="Lead → Penawaran → SPK → Pengadaan → Produksi → Pengiriman → Penagihan → Pembayaran"
          refreshedAt={d.refreshedAt} refreshNote="otomatis ±2 menit setelah ada perubahan di Odoo"
          actions={<>
            <DashboardTabs client={access.client} active="quotation" />
            {odoo ? <ButtonLink href={`${odoo}/odoo`} icon="export-arrow-01" primary external>Buka Odoo</ButtonLink> : null}
          </>} />

        <section aria-label="Alur penawaran" className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-9">
          {d.funnel.map((s, i) => {
            const active = p.track === s.key;
            const info = INFO_STEPS.has(s.key);
            const body = (
              <>
                <div className="flex items-center justify-between gap-2">
                  <span className={`grid size-8 place-items-center rounded-lg ${active ? "bg-primary-foreground/15" : "bg-muted"}`}>
                    <Icon name={STEP_ICON[s.key] ?? "document-text"} variant="bulk" className="size-4.5" />
                  </span>
                  <span className={`text-[0.6875rem] font-semibold tabular-nums ${active ? "opacity-70" : "text-muted-foreground"}`}>
                    {String(i + 1).padStart(2, "0")}
                  </span>
                </div>
                <div className={`mt-3 line-clamp-2 min-h-8 text-xs leading-4 font-medium ${active ? "opacity-80" : "text-muted-foreground"}`}>{s.label}</div>
                <div className="text-2xl font-bold tracking-tight"><NumberTicker value={s.reached} /></div>
                <FunnelBar value={s.reached} max={top} label={`${s.label}: ${s.reached}`} active={active} />
                <div className={`mt-2 text-xs ${active ? "opacity-80" : "text-muted-foreground"}`}>
                  {s.key === "absensi"
                    ? `${d.crewHours.toLocaleString("id-ID")} jam kru`
                    : s.key === "lunas" ? "pembayaran penuh"
                    : s.key === "lead" ? `${s.current.toLocaleString("id-ID")} belum ada penawaran`
                    : info ? "SPK aktif" : `${s.current.toLocaleString("id-ID")} berhenti di sini`}
                </div>
                {s.amount !== undefined ? (
                  <div className="mt-0.5 text-xs font-semibold" title={rupiah(s.amount)}>
                    {STEP_NOTE[s.key] ?? ""}{rupiahCompact(s.amount)}
                  </div>
                ) : null}
              </>
            );
            const cls = `block rounded-2xl border p-3.5 ${rise(i)} ${
              active ? "border-primary bg-primary text-primary-foreground shadow-lg" : "bg-card"}`;
            return info ? (
              <div key={s.key} className={cls}>{body}</div>
            ) : (
              <Link key={s.key} aria-current={active ? "true" : undefined} title={active ? "Klik untuk hapus filter" : `Filter tabel: ${s.label}`}
                className={`${cls} transition-all hover:-translate-y-0.5 ${active ? "" : "hover:border-foreground/30 hover:shadow-md"}`}
                href={`/dashboard/quotation${trackerQuery(p, { track: active ? "" : (s.key as typeof p.track), page: 1 })}`}>
                {body}
              </Link>
            );
          })}
        </section>

        {d.value ? (
          <section className="grid gap-3 xl:grid-cols-[3fr_4fr_2fr]">
            <ValueGroup title="Penjualan" icon="chart-2" cols="sm:grid-cols-3" items={[
              { label: "Pipeline lead", value: d.value.pipeline, mockup: d.value.isMockup },
              { label: "Penawaran terbuka", value: d.value.quoted },
              { label: "Nilai SPK", value: d.value.spk },
            ]} />
            <ValueGroup title="Penagihan" icon="receipt-2" cols="sm:grid-cols-4" items={[
              { label: "Sudah ditagih", value: d.value.invoiced },
              { label: "Sudah dibayar", value: d.value.paid, good: true },
              { label: "Piutang", value: d.value.due },
              { label: "Lewat jatuh tempo", value: d.value.overdue, warn: d.value.overdue > 0 },
            ]} />
            <ValueGroup title="Supply chain" icon="box" cols="sm:grid-cols-2" items={[
              { label: "Biaya material (PO)", value: d.value.materialCost },
              { label: "Hutang vendor", value: d.value.vendorDue },
            ]} />
          </section>
        ) : null}

        <Panel>
          <form method="get" className="flex flex-wrap items-center gap-2 border-b p-3 text-sm">
            <input type="hidden" name="client" value={access.client} />
            <label className="relative min-w-0 flex-1 basis-64">
              <span className="sr-only">Cari</span>
              <Icon name="search-normal" className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <input name="q" defaultValue={p.q} maxLength={60} placeholder="Cari no penawaran/SPK, klien, brand, AE"
                className={`${INPUT} w-full pl-9`} />
            </label>
            <label className="sr-only" htmlFor="track">Tahap</label>
            <select id="track" name="track" defaultValue={p.track} className={INPUT}>
              <option value="">Semua tahap (tanpa batal)</option>
              {Object.entries(TRACK_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
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
            <Link href={`/dashboard/quotation?client=${access.client}`} className="px-2 text-muted-foreground underline underline-offset-4 hover:text-foreground">Reset</Link>
            {d.cancelled ? <span className="ml-auto text-xs text-muted-foreground">{d.cancelled} batal disembunyikan</span> : null}
          </form>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className={TH}>No Penawaran / SPK</th>
                  <th className={TH}>Klien / Brand</th>
                  <th className={TH}>Tahap</th>
                  <th className={`hidden md:table-cell ${TH}`}>Produksi</th>
                  <th className={`hidden xl:table-cell ${TH}`}>Pengadaan &amp; kirim</th>
                  <th className={`hidden text-right lg:table-cell ${TH}`}>Absensi kru</th>
                  <th className={TH}>Penagihan</th>
                  <th className={`hidden lg:table-cell ${TH}`}>Pembayaran</th>
                  {access.canSeeValue ? <th className={`text-right ${TH}`}>Nilai / Piutang</th> : null}
                </tr>
              </thead>
              <tbody>
                {d.rows.map((r) => (
                  <tr key={r.soId} className={ROW}>
                    <td className={TD}>
                      <Link href={`/dashboard/spk/${r.soId}?client=${access.client}`} className={`${LINK} whitespace-nowrap`}>{r.spkNo}</Link>
                      <div className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                        <Icon name="calendar" className="size-3.5" />
                        {r.quotationName && r.quotationName !== r.spkNo ? `${r.quotationName} · ` : ""}{tanggal(r.dateOrder)}
                      </div>
                      <div className="text-xs text-muted-foreground lg:hidden">AE {r.ae ?? "-"}</div>
                    </td>
                    <td className={TD}><div className="font-medium">{r.customer ?? "-"}</div><div className="text-xs text-muted-foreground">{r.brand}</div></td>
                    <td className={TD}>
                      <Badge tone={trackTone(r.track)}>{TRACK_LABEL[r.track] ?? r.track}</Badge>
                      <TrackSteps track={r.track} />
                    </td>
                    <td className={`hidden md:table-cell ${TD}`}>
                      {r.locations ? (
                        <>
                          <Badge tone={stageTone(r.stage)}>{r.stage}</Badge>
                          <Progress value={r.progress} />
                          <div className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground"><Icon name="location" className="size-3.5" />{r.locations} lokasi</div>
                        </>
                      ) : <Muted>—</Muted>}
                    </td>
                    <td className={`hidden text-xs xl:table-cell ${TD}`}>
                      {r.poCount || r.moCount || r.deliveryCount ? (
                        <div className="flex flex-col gap-1">
                          <span className="inline-flex items-center gap-1"><Icon name="shopping-cart" className="size-3.5 text-muted-foreground" />
                            {r.poCount} PO{r.materialCost !== undefined ? ` · ${rupiahCompact(r.materialCost)}` : ""}</span>
                          <span className="inline-flex items-center gap-1 text-muted-foreground"><Icon name="3dcube" className="size-3.5" />MO {r.moDone}/{r.moCount}</span>
                          <span className="inline-flex items-center gap-1 text-muted-foreground"><Icon name="truck-fast" className="size-3.5" />SJ {r.deliveryDone}/{r.deliveryCount}</span>
                        </div>
                      ) : <Muted>—</Muted>}
                    </td>
                    <td className={`hidden text-right tabular-nums lg:table-cell ${TD}`}>
                      {r.crewHours ? <>{r.crewPeople} org<div className="text-xs text-muted-foreground">{r.crewHours.toLocaleString("id-ID")} jam</div></> : <Muted>—</Muted>}
                    </td>
                    <td className={TD}>
                      {r.invoiceCount ? `${r.invoiceCount} invoice` : <Muted>belum</Muted>}
                      {r.nextDueDate ? (
                        <div className={`mt-0.5 flex items-center gap-1 text-xs ${r.overdue ? "font-semibold text-rose-700 dark:text-rose-300" : "text-muted-foreground"}`}>
                          {r.overdue ? <Icon name="warning-2" className="size-3.5" /> : null}jatuh tempo {tanggal(r.nextDueDate)}
                        </div>
                      ) : null}
                    </td>
                    <td className={`hidden lg:table-cell ${TD}`}>
                      {r.paymentCount ? `${r.paymentCount}× bayar` : <Muted>belum</Muted>}
                      {r.lastPaymentDate ? <div className="text-xs text-muted-foreground">terakhir {tanggal(r.lastPaymentDate)}</div> : null}
                    </td>
                    {access.canSeeValue ? (
                      <td className={`whitespace-nowrap text-right tabular-nums ${TD}`}>
                        <span className="font-semibold">{rupiah(r.value)}</span>{r.isMockup ? <MockupBadge short /> : null}
                        <div className="text-xs text-muted-foreground">piutang {rupiah(r.due)}</div>
                      </td>
                    ) : null}
                  </tr>
                ))}
                {d.rows.length === 0 ? <EmptyRow cols={cols}>Tidak ada data untuk filter ini</EmptyRow> : null}
              </tbody>
            </table>
          </div>
        </Panel>

        <Pagination total={d.total} page={p.page} pages={pages}
          prev={p.page > 1 ? `/dashboard/quotation${trackerQuery(p, { page: p.page - 1 })}` : undefined}
          next={p.page < pages ? `/dashboard/quotation${trackerQuery(p, { page: p.page + 1 })}` : undefined} />

        {d.openLeads.length ? (
          <Panel title="Lead CRM terbaru yang belum jadi penawaran" icon="user-tag" count={d.openLeads.length}>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="bg-muted/50">
                  <tr>
                    <th className={TH}>Lead</th><th className={TH}>Klien / Brand</th><th className={TH}>Tahap CRM</th>
                    <th className={`hidden md:table-cell ${TH}`}>AE</th><th className={TH}>Dibuat</th>
                    {access.canSeeValue ? <th className={`text-right ${TH}`}>Perkiraan nilai</th> : null}
                  </tr>
                </thead>
                <tbody>
                  {d.openLeads.map((x) => (
                    <tr key={x.leadId} className={ROW}>
                      <td className={TD}>
                        {odoo ? <a href={`${odoo}/odoo/crm/${x.leadId}`} className={LINK}>{x.name}</a> : <span className="font-semibold">{x.name}</span>}
                      </td>
                      <td className={TD}>{x.customer ?? "-"}<div className="text-xs text-muted-foreground">{x.brand}</div></td>
                      <td className={TD}>{x.stage ? <Badge tone={trackTone("")}>{x.stage}</Badge> : "-"}</td>
                      <td className={`hidden md:table-cell ${TD}`}>{x.ae ?? "-"}</td>
                      <td className={`whitespace-nowrap ${TD}`}>{tanggal(x.createdAt)}</td>
                      {access.canSeeValue ? <td className={`text-right tabular-nums ${TD}`}>{rupiah(x.expectedRevenue)}</td> : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        ) : null}
      </main>
    </>
  );
}

type ValueItem = { label: string; value: number; mockup?: boolean; warn?: boolean; good?: boolean };

/** Kelompok nilai (bento): judul + ubin Rupiah ringkas; nilai penuh di tooltip. */
function ValueGroup(props: { title: string; icon: IconName; cols: string; items: ValueItem[] }) {
  return (
    <div className={`rounded-2xl border bg-card p-4 ${rise(3)}`}>
      <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        <Icon name={props.icon} className="size-4" />{props.title}
      </div>
      <div className={`mt-3 grid grid-cols-2 gap-x-4 gap-y-3 ${props.cols}`}>
        {props.items.map((it) => (
          <div key={it.label} title={rupiah(it.value)}
            className={`min-w-0 border-l-2 pl-3 ${it.warn ? "border-rose-500" : it.good ? "border-emerald-500" : "border-border"}`}>
            <div className="flex items-center text-xs text-muted-foreground"><span className="truncate">{it.label}</span>{it.mockup ? <MockupBadge short /> : null}</div>
            <div className={`text-lg font-bold tracking-tight tabular-nums ${it.warn ? "text-rose-700 dark:text-rose-300" : ""}`}>
              {rupiahCompact(it.value)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
