
/**
 * Bar tanpa atribut style (CSP control-plane: style-src 'self' 'nonce-…' memblokir style inline).
 * Lebar lewat atribut SVG / elemen <meter> — bukan CSS inline.
 */
const STAGE_FILL: Record<string, string> = {
  Desain: "#cbd5e1", Produksi: "#93c5fd", Instalasi: "#67e8f9", Laporan: "#fcd34d", BAST: "#6ee7b7", Selesai: "#34d399",
};

export function StageBar(props: { stages: { stage: string; count: number; href: string; active: boolean }[] }) {
  const total = Math.max(1, props.stages.reduce((s, x) => s + x.count, 0));
  const widths = props.stages.map((s) => Math.max(s.count ? 20 : 0, (1000 * s.count) / total));
  const offsets = widths.map((_, i) => widths.slice(0, i).reduce((a, b) => a + b, 0));
  return (
    <svg viewBox="0 0 1000 28" preserveAspectRatio="none" className="h-7 w-full" role="img" aria-label="Distribusi tahap SPK">
      {props.stages.map((s, i) => (
        <a key={s.stage} href={s.href}>
          <title>{`${s.stage}: ${s.count}`}</title>
          <rect x={offsets[i]} y={0} width={widths[i]} height={28} fill={STAGE_FILL[s.stage] ?? "#e2e8f0"}
            stroke={s.active ? "#0f172a" : "#ffffff"} strokeWidth={s.active ? 4 : 2} />
        </a>
      ))}
    </svg>
  );
}

export function ValueBar(props: { value: number; max: number; label: string }) {
  const w = props.max > 0 ? Math.max(4, (200 * props.value) / props.max) : 0;
  return (
    <svg viewBox="0 0 200 8" preserveAspectRatio="none" className="h-2 w-full" role="img" aria-label={props.label}>
      <rect x={0} y={0} width={200} height={8} rx={3} fill="#f1f5f9" />
      <rect x={0} y={0} width={w} height={8} rx={3} fill="#2563eb" />
    </svg>
  );
}

export function Progress({ value }: { value: number }) {
  return <meter min={0} max={100} value={value} className="mt-1 block h-2 w-24" title={`${value}%`} />;
}

/** Lebar langkah funnel Quotation Tracker (relatif ke jumlah penawaran). */
export function FunnelBar(props: { value: number; max: number; label: string }) {
  const w = props.max > 0 ? Math.max(props.value > 0 ? 6 : 0, (200 * props.value) / props.max) : 0;
  return (
    <svg viewBox="0 0 200 6" preserveAspectRatio="none" className="h-1.5 w-full" role="img" aria-label={props.label}>
      <rect x={0} y={0} width={200} height={6} rx={3} fill="#e2e8f0" />
      <rect x={0} y={0} width={w} height={6} rx={3} fill="#334155" />
    </svg>
  );
}

const TRACK_STEPS = ["penawaran", "spk", "produksi", "ditagih", "lunas"];

/** Titik tahap Penawaran → SPK → Produksi → Ditagih → Lunas (terisi = sudah dilewati). */
export function TrackSteps({ track }: { track: string }) {
  const at = TRACK_STEPS.indexOf(track);
  return (
    <span className="mt-1 flex gap-0.5" aria-hidden="true">
      {TRACK_STEPS.map((s, i) => (
        <span key={s} className={`h-1.5 w-4 rounded-sm ${at >= 0 && i <= at ? "bg-slate-700" : "bg-slate-200"}`} />
      ))}
    </span>
  );
}
