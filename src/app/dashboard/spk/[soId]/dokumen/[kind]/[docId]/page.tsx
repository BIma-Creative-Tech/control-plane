import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Icon, type IconName } from "@/components/icon";
import { datamartEnabled } from "@/db/datamart";
import { requirePermission } from "@/lib/authz";
import { PAYMENT_STATE_LABEL, SCM_KIND_LABEL, SCM_STATE_LABEL, rupiah, scmTone, tanggal } from "@/lib/format";
import { docHref, groupProcurement, isDocKind, type DocKind, type ScmDoc } from "@/lib/scm";
import { parseSpkListParams } from "@/lib/spk-params";
import { accessFor, getScmDocument, type ScmLine } from "@/server/spk-dashboard";
import { Nav } from "../../../../../../nav";
import { Badge, EmptyRow, LINK, Muted, Panel, ROW, TD, TH, rise, toneClass } from "../../../../../ui";

const KIND_ICON: Record<DocKind, IconName> = {
  po: "shopping-cart", receipt: "box", bill: "receipt-2", payment: "money-send", mo: "3dcube", delivery: "truck-fast",
};
const KIND_LABEL = (k: DocKind) => (k === "payment" ? "Pembayaran ke vendor" : SCM_KIND_LABEL[k] ?? k);
const QTY = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 2 });
const qty = (v: number | null) => (v === null ? "—" : QTY.format(v));

/**
 * Detail satu dokumen supply chain SPK (2026-10-01): PO, penerimaan (GR), tagihan vendor, pembayaran ke vendor, MO,
 * surat jalan — dengan alur dokumen terkait dan baris barang. Akses sama dengan detail SPK; dokumen harus milik SPK
 * ini; pembayaran & nominal hanya untuk hak nilai.
 */
export default async function ScmDocumentPage(props: PageProps<"/dashboard/spk/[soId]/dokumen/[kind]/[docId]">) {
  const session = await requirePermission("dashboard:view");
  const sub = session.user?.id;
  if (!datamartEnabled() || !sub) notFound();
  const { soId: rawSo, kind, docId: rawDoc } = await props.params;
  const soId = Number(rawSo);
  const docId = Number(rawDoc);
  const valid = (n: number) => Number.isInteger(n) && n > 0 && n <= 2_147_483_647;
  if (!valid(soId) || !valid(docId) || !isDocKind(kind)) notFound();
  const p = parseSpkListParams(await props.searchParams);
  if (!p.client) redirect("/dashboard");
  const access = await accessFor(sub, p.client);
  if (!access) redirect("/forbidden");
  const d = await getScmDocument(sub, access, soId, kind, docId);
  if (!d) notFound();
  const withValue = access.canSeeValue;
  const href = (k: DocKind, id: number) => docHref(access.client, soId, k, id);
  const back = "inline-flex min-h-9 items-center gap-1.5 rounded-lg px-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground";

  const { rows, mos, deliveries } = groupProcurement(d.scm, d.vendorPayments);
  const payBills = new Set(d.payment?.map((x) => x.billId));
  const group = kind === "payment"
    ? rows.find((r) => r.bills.some((b) => payBills.has(b.docId)))
    : rows.find((r) => (kind === "po" && r.po?.docId === docId) || (kind === "receipt" && r.receipts.some((x) => x.docId === docId))
      || (kind === "bill" && r.bills.some((x) => x.docId === docId)));
  const pay = d.payment;
  const doc = d.doc;
  const title = doc?.docNo ?? pay?.[0]?.paymentNo ?? `#${docId}`;
  const date = doc?.date ?? pay?.[0]?.date ?? null;
  const party = doc?.party ?? group?.po?.party ?? null;
  const status = doc ? docStatus(doc) : { label: "Dibayar", tone: scmTone("done") };
  const amount = doc ? doc.amount : pay?.reduce((s, x) => s + x.amount, 0);

  return (
    <>
      <Nav session={session} />
      <main className="mx-auto max-w-[1600px] space-y-5 px-4 py-6 sm:px-6">
        <nav aria-label="Kembali" className="-ml-2 flex flex-wrap gap-1 text-sm">
          <Link href={`/dashboard/spk/${soId}?client=${access.client}`} className={back}><Icon name="arrow-left-02" className="size-4" />{d.spkNo}</Link>
          <Link href={`/dashboard/spk?client=${access.client}`} className={back}><Icon name="clipboard-tick" className="size-4" />Dashboard SPK</Link>
        </nav>

        <section className={`rounded-2xl border bg-card p-5 sm:p-6 ${rise()}`}>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex min-w-0 items-start gap-4">
              <span className="grid size-12 shrink-0 place-items-center rounded-xl bg-primary text-primary-foreground">
                <Icon name={KIND_ICON[kind]} variant="bulk" className="size-6" />
              </span>
              <div className="min-w-0">
                <div className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">{KIND_LABEL(kind)}</div>
                <h1 className="mt-1 break-all text-2xl font-extrabold tracking-tight tabular-nums sm:text-3xl">{title}</h1>
                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
                  {party ? <span className="inline-flex items-center gap-1.5"><Icon name="buildings" className="size-4" /><span className="font-medium text-foreground">{party}</span></span> : null}
                  <span className="inline-flex items-center gap-1.5"><Icon name="calendar" className="size-4" />{tanggal(date)}</span>
                  <span className="inline-flex items-center gap-1.5"><Icon name="clipboard-tick" className="size-4" />SPK {d.spkNo}{d.customer ? ` · ${d.customer}` : ""}</span>
                </div>
                {pay?.[0]?.journal || pay?.[0]?.memo ? (
                  <div className="mt-1 text-xs text-muted-foreground">{[pay[0].journal, pay[0].memo].filter(Boolean).join(" · ")}</div>
                ) : null}
              </div>
            </div>
            <div className="flex flex-col items-end gap-2">
              <Badge tone={status.tone}>{status.label}</Badge>
              {withValue && amount !== undefined && amount !== null ? (
                <div className="text-right">
                  <div className="text-xs text-muted-foreground">{kind === "payment" ? "Total dialokasikan" : "Nilai (tanpa pajak)"}</div>
                  <div className="text-2xl font-bold tabular-nums">{rupiah(amount)}</div>
                  {doc?.kind === "bill" && doc.amountPaid != null ? <div className="text-xs text-muted-foreground">dibayar {rupiah(doc.amountPaid)}</div> : null}
                </div>
              ) : null}
            </div>
          </div>

          <Flow>
            {kind === "mo" || kind === "delivery" ? (
              <>
                <Step title="Perintah produksi" icon="3dcube" docs={mos} current={{ kind, docId }} href={(x) => href("mo", x.docId)} />
                <Step title="Surat jalan" icon="truck-fast" docs={deliveries} current={{ kind, docId }} href={(x) => href("delivery", x.docId)} />
              </>
            ) : (
              <>
                <Step title="Purchase Order" icon="shopping-cart" docs={group?.po ? [group.po] : []} current={{ kind, docId }} href={(x) => href("po", x.docId)} />
                <Step title="Penerimaan (GR)" icon="box" docs={group?.receipts ?? []} current={{ kind, docId }} href={(x) => href("receipt", x.docId)}
                  empty={group?.po && !group.po.detail ? "— (jasa)" : "belum"} />
                <Step title="Tagihan vendor" icon="receipt-2" docs={group?.bills ?? []} current={{ kind, docId }} href={(x) => href("bill", x.docId)} />
                {withValue ? (
                  <Step title="Pembayaran" icon="money-send" current={{ kind, docId }} href={(x) => href("payment", x.docId)}
                    docs={[...new Map((group?.payments ?? []).map((x) => [x.paymentId, x])).values()].map((x) => ({
                      kind: "payment", docId: x.paymentId, docNo: x.paymentNo ?? `#${x.paymentId}`, state: x.state, date: x.date,
                      party: null, detail: null, poId: x.poId,
                    }))} />
                ) : null}
              </>
            )}
          </Flow>
        </section>

        {kind === "payment" && pay ? (
          <Panel title="Tagihan yang dibayar" icon="receipt-2" count={pay.length} className={rise(1)}>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="bg-muted/50">
                  <tr><th className={TH}>Tagihan vendor</th><th className={TH}>PO</th><th className={`text-right ${TH}`}>Dialokasikan</th></tr>
                </thead>
                <tbody>
                  {pay.map((x) => {
                    const po = d.scm.find((s) => s.kind === "po" && s.docId === x.poId);
                    return (
                      <tr key={`${x.billId}-${x.poId}`} className={ROW}>
                        <td className={TD}><Link href={href("bill", x.billId)} className={LINK}>{x.billNo}</Link></td>
                        <td className={TD}>{po ? <Link href={href("po", po.docId)} className={LINK}>{po.docNo}</Link> : <Muted>—</Muted>}</td>
                        <td className={`text-right tabular-nums ${TD}`}>{rupiah(x.amount)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Panel>
        ) : kind === "mo" ? (
          <>
            <Lines title="Hasil produksi" icon="3dcube" kind="move" lines={d.lines.filter((l) => l.role === "hasil")} withValue={false} index={1} />
            <Lines title="Komponen / material" icon="box" kind="move" lines={d.lines.filter((l) => l.role === "komponen")} withValue={false} index={2} />
          </>
        ) : (
          <Lines title="Barang / jasa" icon="task-square" index={1} withValue={withValue && (kind === "po" || kind === "bill")}
            kind={kind === "po" ? "po" : kind === "bill" ? "bill" : "move"} lines={d.lines} />
        )}
      </main>
    </>
  );
}

function docStatus(doc: ScmDoc): { label: string; tone: string } {
  if (doc.kind === "bill" && doc.state === "posted") {
    const s = doc.detail ?? "not_paid";
    return { label: PAYMENT_STATE_LABEL[s] ?? s, tone: toneClass(s === "paid" || s === "in_payment" ? "good" : "warn") };
  }
  return { label: SCM_STATE_LABEL[doc.state] ?? doc.state, tone: scmTone(doc.state) };
}

function Flow({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-6">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Alur dokumen</div>
      <ol className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">{children}</ol>
    </div>
  );
}

function Step(props: {
  title: string; icon: IconName; docs: ScmDoc[]; current: { kind: string; docId: number }; href: (d: ScmDoc) => string; empty?: string;
}) {
  const here = props.docs.some((x) => x.kind === props.current.kind && x.docId === props.current.docId);
  return (
    <li className={`rounded-xl border p-3 ${here ? "border-foreground bg-muted/60" : props.docs.length ? "" : "border-dashed"}`}>
      <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <Icon name={props.icon} className="size-4" />{props.title}
        {props.docs.length ? <Icon name="tick-circle" variant="bulk" className="ml-auto size-4 text-emerald-600 dark:text-emerald-400" /> : null}
      </div>
      <div className="mt-2 flex flex-col gap-1">
        {props.docs.length ? props.docs.map((x) => (
          x.kind === props.current.kind && x.docId === props.current.docId ? (
            <span key={x.docId} aria-current="page" className="text-sm font-bold">{x.docNo} <span className="font-normal text-muted-foreground">· {tanggal(x.date)}</span></span>
          ) : (
            <span key={x.docId} className="text-sm">
              <Link href={props.href(x)} className={LINK}>{x.docNo}</Link> <span className="text-muted-foreground">· {tanggal(x.date)}</span>
            </span>
          )
        )) : <Muted>{props.empty ?? "belum"}</Muted>}
      </div>
    </li>
  );
}

function Lines(props: { title: string; icon: IconName; kind: "po" | "bill" | "move"; lines: ScmLine[]; withValue: boolean; index: number }) {
  // Produk + kolom qty (PO 3, tagihan 1, move 2) + satuan + subtotal (hak nilai).
  const cols = 2 + (props.kind === "po" ? 3 : props.kind === "bill" ? 1 : 2) + (props.withValue ? 1 : 0);
  return (
    <Panel title={props.title} icon={props.icon} count={props.lines.length} className={rise(props.index)}>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className={`min-w-56 ${TH}`}>Produk</th>
              {props.kind === "po" ? (
                <><th className={`text-right ${TH}`}>Dipesan</th><th className={`text-right ${TH}`}>Diterima</th><th className={`text-right ${TH}`}>Ditagih</th></>
              ) : props.kind === "bill" ? (
                <th className={`text-right ${TH}`}>Qty</th>
              ) : (
                <><th className={`text-right ${TH}`}>Rencana</th><th className={`text-right ${TH}`}>Selesai</th></>
              )}
              <th className={TH}>Satuan</th>
              {props.withValue ? <th className={`text-right ${TH}`}>Subtotal</th> : null}
            </tr>
          </thead>
          <tbody>
            {props.lines.map((l) => {
              const short = l.qty !== null && l.qtyDone !== null && props.kind !== "bill" && l.qtyDone < l.qty;
              return (
                <tr key={l.lineId} className={ROW}>
                  <td className={TD}>
                    <div className="font-medium">{l.product ?? l.description ?? "-"}</div>
                    {l.code ? <div className="text-xs text-muted-foreground">{l.code}</div> : null}
                  </td>
                  {props.kind === "po" ? (
                    <>
                      <td className={`text-right tabular-nums ${TD}`}>{qty(l.qty)}</td>
                      <td className={`text-right tabular-nums ${TD} ${short ? "font-semibold text-amber-700 dark:text-amber-300" : ""}`}>{qty(l.qtyDone)}</td>
                      <td className={`text-right tabular-nums ${TD}`}>{qty(l.qtyBilled)}</td>
                    </>
                  ) : props.kind === "bill" ? (
                    <td className={`text-right tabular-nums ${TD}`}>{qty(l.qty)}</td>
                  ) : (
                    <>
                      <td className={`text-right tabular-nums ${TD}`}>{qty(l.qty)}</td>
                      <td className={`text-right tabular-nums ${TD} ${short ? "font-semibold text-amber-700 dark:text-amber-300" : ""}`}>{qty(l.qtyDone)}</td>
                    </>
                  )}
                  <td className={TD}>{l.uom ?? "-"}</td>
                  {props.withValue ? <td className={`text-right tabular-nums ${TD}`}>{l.amount == null ? "—" : rupiah(l.amount)}</td> : null}
                </tr>
              );
            })}
            {props.lines.length === 0 ? <EmptyRow cols={cols}>Tidak ada baris</EmptyRow> : null}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
