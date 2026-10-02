import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Icon, type IconName } from "@/components/icon";
import { datamartEnabled } from "@/db/datamart";
import { requirePermission } from "@/lib/authz";
import {
  ACTIVITY_LABEL, PAYMENT_STATE_LABEL, TRACK_LABEL, rupiah, scmTone, stageTone, tanggal,
  tanggalJam, trackTone,
} from "@/lib/format";
import { odooUrlFor } from "@/lib/odoo-links";
import { parseSpkListParams } from "@/lib/spk-params";
import { accessFor, getSpkDetail } from "@/server/spk-dashboard";
import { Nav } from "../../../nav";
import { Badge, EmptyRow, MockupBadge, Panel, ROW, TD, TH, rise } from "../../ui";
import { Progress, TrackStepper } from "../bars";
import { IssueBadge, IssuesPanel } from "./issues";
import { Procurement } from "./procurement";

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
  const back = "inline-flex min-h-9 items-center gap-1.5 rounded-lg px-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground";

  return (
    <>
      <Nav session={session} />
      <main className="mx-auto max-w-[1600px] space-y-5 px-4 py-6 sm:px-6">
        <nav aria-label="Kembali" className="-ml-2 flex flex-wrap gap-1 text-sm">
          <Link href={`/dashboard/quotation?client=${access.client}`} className={back}><Icon name="arrow-left-02" className="size-4" />Quotation Tracker</Link>
          <Link href={`/dashboard/spk?client=${access.client}`} className={back}><Icon name="clipboard-tick" className="size-4" />Dashboard SPK</Link>
        </nav>

        <section className={`rounded-2xl border bg-card p-5 sm:p-6 ${rise()}`}>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">{access.client} · SPK</div>
              {/* Nomor dokumen pakai Manrope: angka 0 Syne mirip huruf "o". */}
              <h1 className="mt-1 break-all text-2xl font-extrabold tracking-tight tabular-nums sm:text-3xl">{s.spkNo}</h1>
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
                <span className="inline-flex items-center gap-1.5"><Icon name="buildings" className="size-4" />
                  <span className="font-medium text-foreground">{s.customer ?? "-"}</span>{s.brand ? ` · ${s.brand}` : ""}</span>
                <span className="inline-flex items-center gap-1.5"><Icon name="user-tag" className="size-4" />AE {s.ae ?? "-"}</span>
                <span className="inline-flex items-center gap-1.5"><Icon name="calendar" className="size-4" />{tanggal(s.dateOrder)}</span>
              </div>
              {s.quotationName || s.legacyRef ? (
                <div className="mt-1 text-xs text-muted-foreground">
                  {s.quotationName ? `Penawaran ${s.quotationName}` : ""}{s.legacyRef ? ` · No lama ${s.legacyRef}` : ""}
                </div>
              ) : null}
            </div>
            <div className="flex flex-col items-end gap-1.5">
              <div className="flex gap-1.5">
                <Badge tone={trackTone(d.track)}>{TRACK_LABEL[d.track] ?? d.track}</Badge>
                <Badge tone={stageTone(s.stage)}>{s.stage}</Badge>
                <IssueBadge count={s.issueCount} />
              </div>
              <Progress value={s.progress} />
            </div>
          </div>

          <div className="mt-5"><TrackStepper track={d.track} /></div>

          <div className="mt-5 flex items-start gap-3 rounded-xl bg-muted/70 p-3 text-sm">
            <Icon name="clock" className="mt-0.5 size-4 text-muted-foreground" />
            <div>
              <span className="text-muted-foreground">Status terakhir: </span>
              <span className="font-semibold">{s.lastStatus ?? "-"}</span>
              <span className="text-muted-foreground"> · {tanggalJam(s.lastStatusAt)}</span>
            </div>
          </div>

          {access.canSeeValue ? (
            <dl className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
              <Amount label="Nilai SPK" value={s.value} mockup={s.isMockup} icon="wallet-money" />
              <Amount label="Sudah ditagih" value={s.invoiced} icon="receipt-2" />
              <Amount label="Sudah dibayar" value={s.paid} icon="money-recive" />
              <Amount label="Piutang" value={s.due} icon="empty-wallet" />
            </dl>
          ) : null}
        </section>

        <div className="grid gap-5 2xl:grid-cols-2">
          <Panel title="Penagihan" icon="receipt-2" count={d.invoices.length} className={rise(1)}>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="bg-muted/50">
                  <tr>
                    <th className={TH}>No invoice</th><th className={TH}>Tanggal</th><th className={TH}>Jatuh tempo</th>
                    <th className={TH}>Status bayar</th>
                    {access.canSeeValue ? <><th className={`text-right ${TH}`}>Total</th><th className={`text-right ${TH}`}>Sisa</th></> : null}
                  </tr>
                </thead>
                <tbody>
                  {d.invoices.map((i) => (
                    <tr key={i.invoiceId} className={ROW}>
                      <td className={`font-medium ${TD}`}>
                        {i.invoiceNo}
                        {i.isRefund ? <Badge tone={scmTone("cancel")} className="ml-1">refund</Badge> : null}
                        {i.state === "draft" ? <Badge tone={scmTone("draft")} className="ml-1">draft</Badge> : null}
                      </td>
                      <td className={`whitespace-nowrap ${TD}`}>{tanggal(i.invoiceDate)}</td>
                      <td className={`whitespace-nowrap ${TD} ${i.isOverdue ? "font-semibold text-rose-700 dark:text-rose-300" : ""}`}>
                        <span className="inline-flex items-center gap-1">{i.isOverdue ? <Icon name="warning-2" className="size-3.5" /> : null}{tanggal(i.dueDate)}{i.isOverdue ? " · lewat" : ""}</span>
                      </td>
                      <td className={TD}>
                        {i.paymentState ? (
                          <Badge tone={i.paymentState === "paid" ? scmTone("done") : i.paymentState === "not_paid" ? scmTone("draft") : scmTone("confirmed")}>
                            {PAYMENT_STATE_LABEL[i.paymentState] ?? i.paymentState}
                          </Badge>
                        ) : "-"}
                      </td>
                      {access.canSeeValue ? (
                        <>
                          <td className={`text-right tabular-nums ${TD}`}>{rupiah(i.amountTotal)}</td>
                          <td className={`text-right tabular-nums ${TD}`}>{rupiah(i.residual)}</td>
                        </>
                      ) : null}
                    </tr>
                  ))}
                  {d.invoices.length === 0 ? <EmptyRow cols={access.canSeeValue ? 6 : 4}>Belum ada invoice</EmptyRow> : null}
                </tbody>
              </table>
            </div>
          </Panel>

          {d.payments ? (
            <Panel title="Pembayaran" icon="money-recive" count={d.payments.length} className={rise(2)}>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="bg-muted/50">
                    <tr>
                      <th className={TH}>Tanggal</th><th className={TH}>No pembayaran</th><th className={TH}>Untuk invoice</th>
                      <th className={TH}>Jurnal / memo</th><th className={`text-right ${TH}`}>Jumlah</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.payments.map((x) => (
                      <tr key={`${x.paymentId}-${x.invoiceNo}`} className={ROW}>
                        <td className={`whitespace-nowrap ${TD}`}>{tanggal(x.date)}</td>
                        <td className={`font-medium ${TD}`}>{x.paymentNo ?? "-"}</td>
                        <td className={TD}>{x.invoiceNo}</td>
                        <td className={TD}>{x.journal ?? "-"}<div className="text-xs text-muted-foreground">{x.memo}</div></td>
                        <td className={`text-right font-semibold tabular-nums ${TD}`}>{rupiah(x.amount)}</td>
                      </tr>
                    ))}
                    {d.payments.length === 0 ? <EmptyRow cols={5}>Belum ada pembayaran</EmptyRow> : null}
                  </tbody>
                </table>
              </div>
            </Panel>
          ) : null}
        </div>

        <IssuesPanel issues={d.issues} odooUrl={odooUrlFor(access.client)} />

        <Procurement client={access.client} soId={soId} scm={d.scm} products={d.products}
          vendorPayments={d.vendorPayments} canSeeValue={access.canSeeValue} />

        <Panel title="Lokasi" icon="location" count={d.locations.length} className={rise(4)}>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className={TH}>Lokasi</th><th className={TH}>Tahap</th><th className={TH}>Deadline</th>
                  <th className={TH}>Kegiatan terakhir</th><th className={`text-right ${TH}`}>Kru (orang / jam)</th>
                  {access.canSeeValue ? <th className={`text-right ${TH}`}>Nilai</th> : null}
                </tr>
              </thead>
              <tbody>
                {d.locations.map((l) => (
                  <tr key={l.taskId} className={ROW}>
                    <td className={`font-medium ${TD}`}>{l.location}</td>
                    <td className={TD}><Badge tone={stageTone(l.stage)}>{l.stage}</Badge><Progress value={l.progress} /></td>
                    <td className={`whitespace-nowrap ${TD}`}>{tanggal(l.deadline)}</td>
                    <td className={TD}>{l.lastActivity ?? "-"}<div className="text-xs text-muted-foreground">{tanggal(l.lastActivityDate)}</div></td>
                    <td className={`text-right tabular-nums ${TD}`}>{l.crewPeople} / {l.crewHours.toLocaleString("id-ID")}</td>
                    {access.canSeeValue ? <td className={`text-right tabular-nums ${TD}`}>{rupiah(l.value)}</td> : null}
                  </tr>
                ))}
                {d.locations.length === 0 ? <EmptyRow cols={access.canSeeValue ? 6 : 5}>Belum ada lokasi (SPK belum dikonfirmasi)</EmptyRow> : null}
              </tbody>
            </table>
          </div>
        </Panel>

        <Panel title="Kegiatan lapangan & absensi kru" icon="people" count={d.activities.length} className={rise(5)}>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-muted/50">
                <tr><th className={TH}>Tanggal</th><th className={TH}>Waktu</th><th className={TH}>Kegiatan</th><th className={TH}>Kru</th><th className={`text-right ${TH}`}>Jam</th></tr>
              </thead>
              <tbody>
                {d.activities.map((a, i) => (
                  <tr key={`${a.date}-${a.slot}-${i}`} className={ROW}>
                    <td className={`whitespace-nowrap ${TD}`}>{tanggal(a.date)}</td>
                    <td className={`capitalize ${TD}`}>{a.slot ?? "-"}</td>
                    <td className={TD}><span className="font-medium">{a.type ? ACTIVITY_LABEL[a.type] ?? a.type : "-"}</span><div className="text-xs text-muted-foreground">{a.description}</div></td>
                    <td className={TD}>{a.crew ?? "-"} <span className="text-xs text-muted-foreground">({a.people})</span></td>
                    <td className={`text-right tabular-nums ${TD}`}>{a.hours.toLocaleString("id-ID")}</td>
                  </tr>
                ))}
                {d.activities.length === 0 ? <EmptyRow cols={5}>Belum ada kegiatan tercatat</EmptyRow> : null}
              </tbody>
            </table>
          </div>
        </Panel>
      </main>
    </>
  );
}

function Amount(props: { label: string; value: number | undefined; mockup?: boolean; icon: IconName }) {
  return (
    <div className="rounded-xl border p-3">
      <dt className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Icon name={props.icon} className="size-4" />{props.label}{props.mockup ? <MockupBadge /> : null}
      </dt>
      <dd className="mt-1 text-lg font-bold tracking-tight tabular-nums">{rupiah(props.value)}</dd>
    </div>
  );
}
