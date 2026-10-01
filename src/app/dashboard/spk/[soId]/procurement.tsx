import Link from "next/link";
import { Icon } from "@/components/icon";
import { PAYMENT_STATE_LABEL, SCM_STATE_LABEL, rupiah, tanggal } from "@/lib/format";
import { docHref, groupProcurement, type ScmDoc, type ScmKind, type VendorPayment } from "@/lib/scm";
import { Badge, EmptyRow, LINK, Muted, Panel, ROW, TD, TH, rise, toneClass } from "../../ui";

/**
 * Pengadaan per PO (2026-10-01): satu baris = PO + GR + tagihan vendor + pembayaran ke vendor, tiap nomor membuka
 * halaman detail dokumen. MO & surat jalan di bawahnya (milik SPK, bukan PO). Nominal & nomor pembayaran hanya untuk
 * pengguna dengan hak nilai (`vendorPayments` hanya terisi untuk mereka).
 */
export function Procurement(props: {
  client: string;
  soId: number;
  scm: ScmDoc[];
  products: Record<string, string>;
  vendorPayments?: VendorPayment[];
  canSeeValue: boolean;
}) {
  const { rows, mos, deliveries } = groupProcurement(props.scm, props.vendorPayments);
  const href = (kind: ScmKind | "payment", id: number) => docHref(props.client, props.soId, kind, id);
  const cols = props.canSeeValue ? 6 : 5;

  return (
    <Panel title="Pengadaan & produksi" icon="shopping-cart" count={rows.length} className={rise(3)}
      aside={<span className="text-xs text-muted-foreground">klik nomor dokumen untuk detail</span>}>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className={`min-w-64 ${TH}`}>Keterangan</th>
              <th className={TH}>No PO</th>
              <th className={TH}>No GR</th>
              <th className={TH}>Tagihan vendor</th>
              <th className={TH}>Pembayaran</th>
              {props.canSeeValue ? <th className={`text-right ${TH}`}>Nilai</th> : null}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const paid = r.bills.reduce((s, b) => s + (b.amountPaid ?? 0), 0);
              const payments = uniquePayments(r.payments);
              return (
                <tr key={r.po?.docId ?? "tanpa-po"} className={ROW}>
                  <td className={TD}>
                    <div className="line-clamp-2 font-semibold">
                      {r.po ? (props.products[`po:${r.po.docId}`] ?? "Pengadaan") : "Penerimaan / tagihan tanpa PO"}
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground">{r.po?.party ?? r.bills[0]?.party ?? r.receipts[0]?.party ?? "-"}</div>
                    <Badge tone={toneClass(r.status.tone)} className="mt-1.5">{r.status.label}</Badge>
                  </td>
                  <td className={TD}>
                    {r.po ? <DocLink href={href("po", r.po.docId)} no={r.po.docNo} sub={`${SCM_STATE_LABEL[r.po.state] ?? r.po.state} · ${tanggal(r.po.date)}`} /> : <Muted>—</Muted>}
                  </td>
                  <td className={TD}>
                    {r.receipts.length ? (
                      <Stack>{r.receipts.map((g) => (
                        <DocLink key={g.docId} href={href("receipt", g.docId)} no={g.docNo}
                          sub={g.state === "done" ? `diterima ${tanggal(g.date)}` : `${SCM_STATE_LABEL[g.state] ?? g.state} · ${tanggal(g.date)}`} />
                      ))}</Stack>
                    ) : <Muted>{r.po && !r.po.detail ? "— (jasa)" : "belum"}</Muted>}
                  </td>
                  <td className={TD}>
                    {r.bills.length ? (
                      <Stack>{r.bills.map((b) => (
                        <DocLink key={b.docId} href={href("bill", b.docId)} no={b.docNo}
                          sub={b.state === "posted" ? (PAYMENT_STATE_LABEL[b.detail ?? ""] ?? b.detail ?? "-") : (SCM_STATE_LABEL[b.state] ?? b.state)} />
                      ))}</Stack>
                    ) : <Muted>belum</Muted>}
                  </td>
                  <td className={TD}>
                    {props.canSeeValue ? (
                      payments.length ? (
                        <Stack>{payments.map((p) => (
                          <DocLink key={p.paymentId} href={href("payment", p.paymentId)} no={p.paymentNo ?? `#${p.paymentId}`}
                            sub={`${tanggal(p.date)} · ${rupiah(p.amount)}`} />
                        ))}</Stack>
                      ) : <Muted>belum</Muted>
                    ) : (
                      <Muted>{r.bills.length ? r.status.label.replace(" ke vendor", "") : "—"}</Muted>
                    )}
                  </td>
                  {props.canSeeValue ? (
                    <td className={`whitespace-nowrap text-right tabular-nums ${TD}`}>
                      <span className="font-semibold">{r.po?.amount != null ? rupiah(r.po.amount) : "—"}</span>
                      {r.bills.length ? <div className="text-xs text-muted-foreground">dibayar {rupiah(paid)}</div> : null}
                    </td>
                  ) : null}
                </tr>
              );
            })}
            {rows.length === 0 ? <EmptyRow cols={cols}>Belum ada PO untuk SPK ini</EmptyRow> : null}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-start gap-x-6 gap-y-3 border-t bg-muted/30 px-4 py-3 text-sm">
        <span className="flex items-center gap-2 font-semibold"><Icon name="3dcube" className="size-4" />Produksi</span>
        {mos.length ? mos.map((m) => (
          <DocLink key={m.docId} href={href("mo", m.docId)} no={m.docNo}
            sub={`${props.products[`mo:${m.docId}`] ?? m.detail ?? ""} · ${SCM_STATE_LABEL[m.state] ?? m.state}`} />
        )) : <Muted>belum ada MO</Muted>}
        <Icon name="arrow-right-02" className="mt-0.5 size-4 text-muted-foreground" />
        <span className="flex items-center gap-2 font-semibold"><Icon name="truck-fast" className="size-4" />Pengiriman</span>
        {deliveries.length ? deliveries.map((s) => (
          <DocLink key={s.docId} href={href("delivery", s.docId)} no={s.docNo}
            sub={s.state === "done" ? `terkirim ${tanggal(s.date)}` : `${SCM_STATE_LABEL[s.state] ?? s.state} · ${tanggal(s.date)}`} />
        )) : <Muted>belum ada surat jalan</Muted>}
      </div>
    </Panel>
  );
}

function uniquePayments(ps: VendorPayment[]): VendorPayment[] {
  const m = new Map<number, VendorPayment>();
  for (const p of ps) {
    const prev = m.get(p.paymentId);
    m.set(p.paymentId, prev ? { ...prev, amount: prev.amount + p.amount } : p);
  }
  return [...m.values()];
}

const Stack = ({ children }: { children: React.ReactNode }) => <div className="flex flex-col gap-1.5">{children}</div>;

function DocLink({ href, no, sub }: { href: string; no: string; sub?: string }) {
  return (
    <div className="min-w-0">
      <Link href={href} className={`${LINK} whitespace-nowrap`}>{no}</Link>
      {sub ? <div className="text-xs text-muted-foreground">{sub}</div> : null}
    </div>
  );
}
