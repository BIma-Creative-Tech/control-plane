import Link from "next/link";
import { Icon, type IconName } from "@/components/icon";
import { datamartEnabled } from "@/db/datamart";
import { requirePermission } from "@/lib/authz";
import { logger } from "@/lib/logger";
import { listAccess, type ClientAccess } from "@/server/spk-dashboard";
import { Nav } from "../nav";
import { PageHeader, rise } from "./ui";

export default async function DashboardPage() {
  const session = await requirePermission("dashboard:view");
  const sub = session.user?.id;
  let access: ClientAccess[] = [];
  let failed = false;
  if (datamartEnabled() && sub) {
    try {
      access = await listAccess(sub);
    } catch (err) {
      failed = true;
      logger.error({ err: err instanceof Error ? err.name : "unknown" }, "dashboard: baca mart_user_access gagal");
    }
  }
  return (
    <>
      <Nav session={session} />
      <main className="mx-auto max-w-[1600px] space-y-6 px-4 py-6 sm:px-6 sm:py-8">
        <PageHeader eyebrow="Control Plane" title="Dashboard"
          subtitle="Pilih dashboard perusahaan Anda. Data diambil dari Odoo lewat data mart." />
        {failed ? (
          <p role="alert" className="flex items-center gap-2 rounded-xl border border-rose-500/40 bg-rose-500/10 p-3 text-sm text-rose-800 dark:text-rose-300">
            <Icon name="warning-2" className="size-4" />Data dashboard sedang tidak tersedia. Coba lagi beberapa menit lagi.
          </p>
        ) : null}
        {!failed && access.length === 0 ? (
          <p className="rounded-xl border border-dashed bg-card p-6 text-sm text-muted-foreground">
            Belum ada data. Dashboard SPK tampil untuk akun yang terhubung ke Odoo perusahaan Anda (login SSO).
          </p>
        ) : null}
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {access.flatMap((a, i) => [
            <Card key={`${a.client}-quotation`} index={i * 2} client={a.client} icon="presention-chart"
              href={`/dashboard/quotation?client=${a.client}`} title="Quotation Tracker"
              body={`Lead → Penawaran → SPK → Produksi → Penagihan → Pembayaran · ${a.name}`} />,
            <Card key={`${a.client}-spk`} index={i * 2 + 1} client={a.client} icon="clipboard-tick"
              href={`/dashboard/spk?client=${a.client}`} title="Dashboard SPK"
              body={`${a.canSeeValue ? "Status & nilai proyek" : "Status pengerjaan"} · ${a.name}`} />,
          ])}
        </div>
      </main>
    </>
  );
}

function Card(props: { client: string; href: string; title: string; body: string; icon: IconName; index: number }) {
  return (
    <Link href={props.href}
      className={`group relative flex flex-col gap-6 overflow-hidden rounded-2xl border bg-card p-5 transition-all hover:-translate-y-0.5 hover:border-foreground/30 hover:shadow-lg ${rise(props.index + 1)}`}>
      <div className="flex items-start justify-between">
        <span className="grid size-11 place-items-center rounded-xl bg-primary text-primary-foreground">
          <Icon name={props.icon} variant="bulk" className="size-6" />
        </span>
        <span className="rounded-full border px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">{props.client}</span>
      </div>
      <div>
        <div className="flex items-center gap-2 font-heading text-lg font-bold">
          {props.title}
          <Icon name="arrow-right-02" className="size-4 transition-transform group-hover:translate-x-1" />
        </div>
        <p className="mt-1 text-sm text-muted-foreground">{props.body}</p>
      </div>
    </Link>
  );
}
