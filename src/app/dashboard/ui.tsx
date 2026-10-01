/**
 * Primitif UI dashboard (server component, tanpa atribut `style` — CSP). Gaya: Onyx monokrom ala website
 * expomedia.id + kartu/bento 21st.dev; ikon Iconsax; animasi CSS `rise` hanya untuk `motion-safe`.
 */
import Link from "next/link";
import { Icon, type IconName } from "@/components/icon";
import { NumberTicker } from "@/components/number-ticker";
import { tanggalJam } from "@/lib/format";

/** Jeda bertahap animasi masuk (kelas literal agar terdeteksi Tailwind). */
const RISE = [
  "motion-safe:animate-rise",
  "motion-safe:animate-rise motion-safe:[animation-delay:40ms]",
  "motion-safe:animate-rise motion-safe:[animation-delay:80ms]",
  "motion-safe:animate-rise motion-safe:[animation-delay:120ms]",
  "motion-safe:animate-rise motion-safe:[animation-delay:160ms]",
  "motion-safe:animate-rise motion-safe:[animation-delay:200ms]",
  "motion-safe:animate-rise motion-safe:[animation-delay:240ms]",
  "motion-safe:animate-rise motion-safe:[animation-delay:280ms]",
  "motion-safe:animate-rise motion-safe:[animation-delay:320ms]",
] as const;
export const rise = (i = 0) => RISE[Math.min(Math.max(i, 0), RISE.length - 1)];

export const TH = "px-3 py-2.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground";
export const TD = "px-3 py-3";
export const ROW = "border-t align-top transition-colors hover:bg-muted/60";
export const LINK = "font-semibold text-foreground underline decoration-border underline-offset-4 transition-colors hover:decoration-foreground";
export const INPUT =
  "h-10 rounded-lg border bg-card px-3 text-sm text-foreground transition-colors placeholder:text-muted-foreground focus-visible:border-foreground";

export function PageHeader(props: {
  eyebrow: string;
  title: string;
  subtitle?: React.ReactNode;
  refreshedAt?: Date | string | null;
  refreshNote?: string;
  actions?: React.ReactNode;
}) {
  return (
    <header className={`flex flex-wrap items-end justify-between gap-4 ${rise()}`}>
      <div className="min-w-0">
        <div className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">{props.eyebrow}</div>
        <h1 className="mt-1 font-heading text-2xl font-bold tracking-tight sm:text-3xl">{props.title}</h1>
        {props.subtitle ? <p className="mt-1 text-sm text-muted-foreground">{props.subtitle}</p> : null}
        {props.refreshedAt !== undefined ? (
          <p className="mt-2 inline-flex items-center gap-1.5 rounded-full border bg-card px-2.5 py-1 text-xs text-muted-foreground">
            <span className="relative flex size-2" aria-hidden="true">
              <span className="absolute inline-flex size-full rounded-full bg-emerald-500/60 motion-safe:animate-ping" />
              <span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
            </span>
            Data {tanggalJam(props.refreshedAt)} WIB{props.refreshNote ? ` · ${props.refreshNote}` : ""}
          </p>
        ) : null}
      </div>
      {props.actions ? <div className="flex flex-wrap items-center gap-2">{props.actions}</div> : null}
    </header>
  );
}

/** Pindah Quotation Tracker ↔ Dashboard SPK (segmented control). */
export function DashboardTabs({ client, active }: { client: string; active: "quotation" | "spk" }) {
  const tabs = [
    { key: "quotation", label: "Quotation Tracker", icon: "presention-chart", href: `/dashboard/quotation?client=${client}` },
    { key: "spk", label: "Dashboard SPK", icon: "clipboard-tick", href: `/dashboard/spk?client=${client}` },
  ] as const;
  return (
    <nav aria-label="Jenis dashboard" className="inline-flex rounded-xl border bg-card p-1 text-sm">
      {tabs.map((t) => (
        <Link key={t.key} href={t.href} aria-current={t.key === active ? "page" : undefined}
          className={`inline-flex min-h-9 items-center gap-1.5 rounded-lg px-3 font-medium transition-colors ${
            t.key === active ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`}>
          <Icon name={t.icon} className="size-4" />
          {t.label}
        </Link>
      ))}
    </nav>
  );
}

export function ButtonLink(props: { href: string; children: React.ReactNode; icon?: IconName; primary?: boolean; external?: boolean }) {
  const cls = `inline-flex min-h-10 items-center gap-2 rounded-xl px-4 text-sm font-semibold transition-colors ${
    props.primary ? "bg-primary text-primary-foreground hover:opacity-90" : "border bg-card hover:bg-muted"}`;
  const body = <>{props.children}{props.icon ? <Icon name={props.icon} className="size-4" /> : null}</>;
  return props.external ? <a href={props.href} className={cls}>{body}</a> : <Link href={props.href} className={cls}>{body}</Link>;
}

export function Panel(props: { title?: string; icon?: IconName; count?: number; aside?: React.ReactNode; className?: string; children: React.ReactNode }) {
  return (
    <section className={`overflow-hidden rounded-2xl border bg-card shadow-[0_1px_2px_rgba(0,0,0,.04)] ${props.className ?? ""}`}>
      {props.title ? (
        <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
          <h2 className="flex items-center gap-2 font-heading text-base font-semibold">
            {props.icon ? (
              <span className="grid size-8 place-items-center rounded-lg bg-muted"><Icon name={props.icon} variant="bulk" className="size-4.5" /></span>
            ) : null}
            {props.title}
            {props.count !== undefined ? (
              <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-semibold tabular-nums text-muted-foreground">{props.count}</span>
            ) : null}
          </h2>
          {props.aside}
        </div>
      ) : null}
      {props.children}
    </section>
  );
}

export function Badge({ tone, children, className }: { tone: string; children: React.ReactNode; className?: string }) {
  return (
    <span className={`inline-flex items-center whitespace-nowrap rounded-md px-2 py-0.5 text-xs font-semibold ring-1 ring-inset ${tone} ${className ?? ""}`}>
      {children}
    </span>
  );
}

export function MockupBadge({ short }: { short?: boolean }) {
  return (
    <span title="Nilai mockup (data demo)"
      className="ml-1 rounded bg-amber-400/20 px-1 text-[0.6875rem] font-semibold text-amber-800 dark:text-amber-300">
      {short ? "m" : "mockup"}
    </span>
  );
}

/** Kartu angka (KPI). `value` angka → hitung naik; string → apa adanya (mis. Rupiah ringkas). */
export function StatCard(props: {
  label: string;
  value: number | string;
  icon: IconName;
  sub?: React.ReactNode;
  title?: string;
  tone?: "default" | "info" | "warn" | "good" | "danger";
  badge?: React.ReactNode;
  index?: number;
}) {
  const tone = {
    default: "bg-muted text-foreground",
    info: "bg-blue-500/12 text-blue-700 dark:text-blue-300",
    warn: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
    good: "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300",
    danger: "bg-rose-500/12 text-rose-700 dark:text-rose-300",
  }[props.tone ?? "default"];
  return (
    <div title={props.title}
      className={`rounded-2xl border bg-card p-4 transition-shadow hover:shadow-md ${props.tone === "danger" ? "border-rose-500/40" : ""} ${rise(props.index)}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="text-xs font-medium text-muted-foreground">{props.label}{props.badge}</div>
        <span className={`grid size-8 shrink-0 place-items-center rounded-lg ${tone}`}><Icon name={props.icon} variant="bulk" className="size-4.5" /></span>
      </div>
      <div className="mt-1 text-2xl font-bold tracking-tight tabular-nums">
        {typeof props.value === "number" ? <NumberTicker value={props.value} /> : props.value}
      </div>
      {props.sub ? <div className="mt-0.5 text-xs text-muted-foreground">{props.sub}</div> : null}
    </div>
  );
}

export function Pagination(props: { total: number; page: number; pages: number; prev?: string; next?: string }) {
  const btn = "inline-flex min-h-10 items-center gap-1.5 rounded-xl border bg-card px-3 font-medium transition-colors hover:bg-muted";
  return (
    <nav aria-label="Halaman" className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
      <span><span className="font-semibold tabular-nums text-foreground">{props.total.toLocaleString("id-ID")}</span> data · halaman {props.page} dari {props.pages}</span>
      <span className="flex gap-2">
        {props.prev ? <Link className={btn} href={props.prev}><Icon name="arrow-left-02" className="size-4" />Sebelumnya</Link> : null}
        {props.next ? <Link className={btn} href={props.next}>Berikutnya<Icon name="arrow-right-02" className="size-4" /></Link> : null}
      </span>
    </nav>
  );
}

export function EmptyRow({ cols, children }: { cols: number; children: React.ReactNode }) {
  return (
    <tr>
      <td colSpan={cols} className="px-3 py-10 text-center text-sm text-muted-foreground">{children}</td>
    </tr>
  );
}

export const Muted = ({ children }: { children: React.ReactNode }) => <span className="text-muted-foreground">{children}</span>;
