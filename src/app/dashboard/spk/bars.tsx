
/**
 * Bar tanpa atribut style (CSP control-plane: style-src 'self' 'nonce-…' memblokir style inline).
 * Lebar lewat atribut SVG; warna lewat kelas `fill-*` (ikut tema terang/gelap); animasi tumbuh = keyframe CSS
 * `grow-x` (hanya motion-safe).
 */
const GROW = "origin-left [transform-box:fill-box] motion-safe:animate-grow-x";

const STAGE_FILL: Record<string, string> = {
  Desain: "fill-stone-300 dark:fill-stone-500",
  Produksi: "fill-blue-400",
  Instalasi: "fill-cyan-400",
  Laporan: "fill-amber-400",
  BAST: "fill-emerald-400",
  Selesai: "fill-emerald-600",
};
export const stageFill = (stage: string) => STAGE_FILL[stage] ?? "fill-slate-300 dark:fill-slate-600";

export function StageBar(props: { stages: { stage: string; count: number; href: string; active: boolean }[] }) {
  const total = Math.max(1, props.stages.reduce((s, x) => s + x.count, 0));
  const widths = props.stages.map((s) => Math.max(s.count ? 20 : 0, (1000 * s.count) / total));
  const offsets = widths.map((_, i) => widths.slice(0, i).reduce((a, b) => a + b, 0));
  const anyActive = props.stages.some((s) => s.active);
  return (
    <svg viewBox="0 0 1000 32" preserveAspectRatio="none" className="h-8 w-full overflow-hidden rounded-lg" role="img" aria-label="Distribusi tahap SPK">
      {props.stages.map((s, i) => (
        <a key={s.stage} href={s.href}>
          <title>{`${s.stage}: ${s.count}`}</title>
          <rect x={offsets[i]} y={0} width={widths[i]} height={32}
            className={`${stageFill(s.stage)} ${GROW} transition-opacity hover:opacity-80 ${anyActive && !s.active ? "opacity-35" : ""} stroke-card`}
            strokeWidth={3} />
        </a>
      ))}
    </svg>
  );
}

export function ValueBar(props: { value: number; max: number; label: string }) {
  const w = props.max > 0 ? Math.max(4, (200 * props.value) / props.max) : 0;
  return (
    <svg viewBox="0 0 200 8" preserveAspectRatio="none" className="h-2 w-full" role="img" aria-label={props.label}>
      <rect x={0} y={0} width={200} height={8} rx={4} className="fill-muted" />
      <rect x={0} y={0} width={w} height={8} rx={4} className={`fill-foreground ${GROW}`} />
    </svg>
  );
}

/** Progres 0–100 (bar + persen). */
export function Progress({ value, className }: { value: number; className?: string }) {
  const v = Math.min(100, Math.max(0, value));
  return (
    <span className={`mt-1.5 flex items-center gap-2 ${className ?? ""}`}>
      <svg viewBox="0 0 100 6" preserveAspectRatio="none" className="h-1.5 w-20" role="img" aria-label={`Progres ${v}%`}>
        <rect x={0} y={0} width={100} height={6} rx={3} className="fill-muted" />
        <rect x={0} y={0} width={v} height={6} rx={3} className={`${v >= 100 ? "fill-emerald-500" : "fill-foreground"} ${GROW}`} />
      </svg>
      <span className="text-[0.6875rem] tabular-nums text-muted-foreground">{v}%</span>
    </span>
  );
}

/** Lebar langkah funnel Quotation Tracker (relatif ke langkah pertama). */
export function FunnelBar(props: { value: number; max: number; label: string; active?: boolean }) {
  const w = props.max > 0 ? Math.max(props.value > 0 ? 6 : 0, (200 * props.value) / props.max) : 0;
  return (
    <svg viewBox="0 0 200 6" preserveAspectRatio="none" className="h-1.5 w-full" role="img" aria-label={props.label}>
      <rect x={0} y={0} width={200} height={6} rx={3} className="fill-muted" />
      <rect x={0} y={0} width={w} height={6} rx={3} className={`${props.active ? "fill-primary-foreground" : "fill-foreground"} ${GROW}`} />
    </svg>
  );
}

const TRACK_STEPS = [
  { key: "penawaran", label: "Penawaran" },
  { key: "spk", label: "SPK" },
  { key: "produksi", label: "Produksi" },
  { key: "ditagih", label: "Ditagih" },
  { key: "lunas", label: "Lunas" },
];

/** Segmen tahap Penawaran → SPK → Produksi → Ditagih → Lunas (terisi = sudah dilewati). */
export function TrackSteps({ track }: { track: string }) {
  const at = TRACK_STEPS.findIndex((s) => s.key === track);
  return (
    <span className="mt-1.5 flex gap-0.5" aria-hidden="true">
      {TRACK_STEPS.map((s, i) => (
        <span key={s.key} className={`h-1 w-4 rounded-full ${at >= 0 && i <= at ? (track === "lunas" ? "bg-emerald-500" : "bg-foreground") : "bg-muted"}`} />
      ))}
    </span>
  );
}

/** Stepper besar untuk detail SPK: label + penanda tahap aktif. */
export function TrackStepper({ track }: { track: string }) {
  const at = TRACK_STEPS.findIndex((s) => s.key === track);
  return (
    <ol className="grid grid-cols-5 gap-1.5" aria-label="Tahap penawaran sampai pelunasan">
      {TRACK_STEPS.map((s, i) => {
        const done = at >= 0 && i <= at;
        return (
          <li key={s.key} aria-current={i === at ? "step" : undefined}>
            <span className={`block h-1.5 rounded-full ${done ? (track === "lunas" ? "bg-emerald-500" : "bg-foreground") : "bg-muted"}`} />
            <span className={`mt-1.5 block truncate text-xs ${i === at ? "font-semibold text-foreground" : "text-muted-foreground"}`}>{s.label}</span>
          </li>
        );
      })}
    </ol>
  );
}
