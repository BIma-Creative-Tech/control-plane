import { Icon } from "@/components/icon";
import { rupiah, tanggalJam } from "@/lib/format";
import {
  BAST_KIND_LABEL, BAST_STATE_LABEL, bastStateTone, bastSummary, costSegments, mapsUrl, marginTone, persen,
  type BastCounts, type BastDoc, type SpkCost,
} from "@/lib/spk-cost-bast";
import { Badge, EmptyRow, LINK, MockupBadge, Muted, Panel, ROW, TD, TH, rise, toneClass } from "../../ui";

/**
 * Biaya produksi & margin SPK (plan infra 19) — HANYA dirender untuk canSeeValue (pemanggil). Komponen biaya dari
 * data mart: material = MAX(terpakai, PO barang), jasa = MAX(tagihan vendor, PO jasa), tenaga kerja = timesheet.
 */
export function CostPanel({ cost, mockup }: { cost: SpkCost; mockup?: boolean }) {
  const tone = marginTone(cost.marginPct);
  const marginText = {
    good: "text-emerald-700 dark:text-emerald-300", warn: "text-amber-700 dark:text-amber-300",
    danger: "text-rose-700 dark:text-rose-300", info: "", neutral: "",
  }[tone];
  return (
    <Panel title="Biaya produksi & margin" icon="percentage-square" className={rise(1)}
      aside={<span className="text-xs text-muted-foreground">nilai tanpa PPN − biaya material, jasa/PO & tenaga kerja</span>}>
      <div className="grid gap-5 p-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <div className="space-y-3">
          <dl className="grid grid-cols-2 gap-3">
            <Figure label="Nilai SPK (tanpa PPN)" value={rupiah(cost.valueUntaxed)} badge={mockup ? <MockupBadge /> : null} />
            <Figure label="PPN" value={rupiah(cost.valueTax)} note={`total dengan PPN ${rupiah(cost.valueUntaxed + cost.valueTax)}`} />
            <Figure label="Total biaya produksi" value={rupiah(cost.total)} />
            <Figure label="Margin" value={rupiah(cost.margin)} note={persen(cost.marginPct)} className={marginText} />
          </dl>
          <CostBar cost={cost} />
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-muted/50">
              <tr><th className={TH}>Komponen biaya</th><th className={TH}>Rincian</th><th className={`text-right ${TH}`}>Dibebankan</th></tr>
            </thead>
            <tbody>
              <tr className={ROW}>
                <td className={`font-medium ${TD}`}>Material</td>
                <td className={TD}>
                  terpakai (MO / permintaan barang) {rupiah(cost.materialUsed)}<br />
                  <Muted>PO barang {rupiah(cost.poGoods)} · dibebankan yang terbesar</Muted>
                </td>
                <td className={`text-right tabular-nums ${TD}`}>{rupiah(cost.material)}</td>
              </tr>
              <tr className={ROW}>
                <td className={`font-medium ${TD}`}>Jasa, sewa & subkon</td>
                <td className={TD}>
                  tagihan vendor {rupiah(cost.serviceBilled)}<br />
                  <Muted>PO jasa {rupiah(cost.poService)} · dibebankan yang terbesar</Muted>
                </td>
                <td className={`text-right tabular-nums ${TD}`}>{rupiah(cost.service)}</td>
              </tr>
              <tr className={ROW}>
                <td className={`font-medium ${TD}`}>Tenaga kerja</td>
                <td className={TD}>
                  {cost.laborHours.toLocaleString("id-ID")} jam (absensi kiosk / timesheet)
                  {cost.laborHoursUncosted > 0 ? (
                    <div className="mt-1 flex items-start gap-1 text-xs font-semibold text-amber-700 dark:text-amber-300">
                      <Icon name="warning-2" className="mt-px size-3.5 shrink-0" />
                      {cost.laborHoursUncosted.toLocaleString("id-ID")} jam belum bertarif — isi biaya per jam karyawan di Odoo
                    </div>
                  ) : null}
                </td>
                <td className={`text-right tabular-nums ${TD}`}>{rupiah(cost.labor)}</td>
              </tr>
              {cost.other !== 0 ? (
                <tr className={ROW}>
                  <td className={`font-medium ${TD}`}>Lain-lain</td>
                  <td className={TD}><Muted>baris analitik proyek lainnya</Muted></td>
                  <td className={`text-right tabular-nums ${TD}`}>{rupiah(cost.other)}</td>
                </tr>
              ) : null}
              <tr className="border-t bg-muted/40 font-semibold">
                <td className={TD} colSpan={2}>Total biaya produksi</td>
                <td className={`text-right tabular-nums ${TD}`}>{rupiah(cost.total)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </Panel>
  );
}

function Figure(props: { label: string; value: string; note?: string; badge?: React.ReactNode; className?: string }) {
  return (
    <div className="rounded-xl border p-3">
      <dt className="text-xs text-muted-foreground">{props.label}{props.badge}</dt>
      <dd className={`mt-1 text-lg font-bold tracking-tight tabular-nums ${props.className ?? ""}`}>{props.value}</dd>
      {props.note ? <dd className={`text-xs tabular-nums ${props.className || "text-muted-foreground"}`}>{props.note}</dd> : null}
    </div>
  );
}

const SEG_FILL: Record<string, string> = {
  material: "fill-blue-400", service: "fill-cyan-400", labor: "fill-amber-400", other: "fill-stone-400",
  margin: "fill-emerald-500",
};

/** Komposisi nilai SPK: biaya per komponen + margin (SVG tanpa style inline — CSP). */
function CostBar({ cost }: { cost: SpkCost }) {
  const segs = costSegments(cost);
  const total = Math.max(1, segs.reduce((s, x) => s + x.value, 0));
  const widths = segs.map((s) => (1000 * s.value) / total);
  const offsets = widths.map((_, i) => widths.slice(0, i).reduce((a, b) => a + b, 0));
  if (segs.length === 0) return null;
  return (
    <div>
      <svg viewBox="0 0 1000 14" preserveAspectRatio="none" className="h-3.5 w-full overflow-hidden rounded-full" role="img"
        aria-label="Komposisi biaya dan margin">
        {segs.map((s, i) => (
          <rect key={s.key} x={offsets[i]} y={0} width={widths[i]} height={14} className={`${SEG_FILL[s.key]} stroke-card`} strokeWidth={2}>
            <title>{`${s.label}: ${rupiah(s.value)}`}</title>
          </rect>
        ))}
      </svg>
      <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
        {segs.map((s) => (
          <li key={s.key} className="inline-flex items-center gap-1.5">
            <svg viewBox="0 0 10 10" className="size-2.5" aria-hidden="true"><rect width={10} height={10} rx={3} className={SEG_FILL[s.key]} /></svg>
            {s.label}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Status BAST SPK (daftar & header detail); null bila belum ada BAST. */
export function BastBadge({ bast, className }: { bast: BastCounts; className?: string }) {
  const s = bastSummary(bast);
  if (!s) return null;
  return <Badge tone={toneClass(s.tone)} className={className}>{s.label}</Badge>;
}

/** BAST per SPK (plan infra 19, modul custom_bast): status tanda tangan kedua pihak + lokasi GPS saat TTD. */
export function BastPanel({ basts }: { basts: BastDoc[] }) {
  const active = basts.filter((b) => b.state !== "voided");
  const done = active.filter((b) => b.state === "completed").length;
  return (
    <Panel title="BAST (serah terima)" icon="pen-tool" count={basts.length} className={rise(3)}
      aside={<span className="text-xs text-muted-foreground">{done} dari {active.length} lengkap ditandatangani</span>}>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className={TH}>No BAST</th><th className={TH}>Status</th><th className={TH}>Pihak pertama</th>
              <th className={TH}>Pihak kedua</th><th className={TH}>Lokasi GPS</th>
            </tr>
          </thead>
          <tbody>
            {basts.map((b) => {
              const map = mapsUrl(b.gpsLatitude, b.gpsLongitude);
              return (
                <tr key={b.bastId} className={`${ROW} ${b.state === "voided" ? "opacity-60" : ""}`}>
                  <td className={TD}>
                    <div className="font-semibold tabular-nums">{b.bastNo}</div>
                    <div className="text-xs text-muted-foreground">
                      {BAST_KIND_LABEL[b.kind] ?? b.kind}{b.location ? ` · ${b.location}` : ""} · {tanggalJam(b.dateHandover)}
                    </div>
                  </td>
                  <td className={TD}><Badge tone={toneClass(bastStateTone(b.state))}>{BAST_STATE_LABEL[b.state] ?? b.state}</Badge></td>
                  <Signer party={b.partyFrom} by={b.fromSignedBy} at={b.fromSignedAt} />
                  <Signer party={b.partyTo} by={b.toSignedBy} at={b.toSignedAt} />
                  <td className={TD}>
                    {map ? (
                      <a href={map} target="_blank" rel="noopener noreferrer" className={`${LINK} inline-flex items-center gap-1 whitespace-nowrap`}>
                        <Icon name="gps" className="size-4" />Buka peta
                      </a>
                    ) : <Muted>tidak terekam</Muted>}
                    {map && b.gpsAccuracy ? <div className="text-xs text-muted-foreground">± {Math.round(b.gpsAccuracy)} m</div> : null}
                  </td>
                </tr>
              );
            })}
            {basts.length === 0 ? <EmptyRow cols={5}>Belum ada BAST — buat lewat tombol Generate BAST di SPK (Odoo)</EmptyRow> : null}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function Signer(props: { party: string | null; by: string | null; at: Date | null }) {
  return (
    <td className={TD}>
      <div className="font-medium">{props.party ?? "-"}</div>
      {props.at ? (
        <div className="inline-flex items-center gap-1 text-xs text-emerald-700 dark:text-emerald-300">
          <Icon name="tick-circle" className="size-3.5" />{props.by ?? "ditandatangani"} · {tanggalJam(props.at)}
        </div>
      ) : <div className="text-xs text-muted-foreground">belum TTD</div>}
    </td>
  );
}
