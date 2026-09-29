import Link from "next/link";
import { datamartEnabled } from "@/db/datamart";
import { requirePermission } from "@/lib/authz";
import { logger } from "@/lib/logger";
import { listAccess, type ClientAccess } from "@/server/spk-dashboard";
import { Nav } from "../nav";

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
      <main className="p-6">
        <h1 className="text-lg font-semibold">Dashboard</h1>
        {failed ? <p className="mt-2 text-red-700">Data dashboard sedang tidak tersedia. Coba lagi beberapa menit lagi.</p> : null}
        {!failed && access.length === 0 ? (
          <p className="mt-2 text-slate-600">
            Belum ada data. Dashboard SPK tampil untuk akun yang terhubung ke Odoo perusahaan Anda (login SSO).
          </p>
        ) : null}
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {access.map((a) => (
            <Link key={a.client} href={`/dashboard/spk?client=${a.client}`}
              className="rounded border bg-white p-4 hover:bg-slate-50">
              <div className="text-xs uppercase text-slate-500">{a.client}</div>
              <div className="font-semibold">Dashboard SPK</div>
              <div className="mt-1 text-sm text-slate-600">
                {a.canSeeValue ? "Status & nilai proyek" : "Status pengerjaan"} · {a.name}
              </div>
            </Link>
          ))}
        </div>
      </main>
    </>
  );
}
