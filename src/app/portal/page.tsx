import Link from "next/link";
import { getDb } from "@/db";
import { portalEnvironments, portalOpenInvoices, portalSubscriptions } from "@/db/portal-queries";
import { formatAmount } from "@/lib/billing";
import { PORTAL_SUBSCRIPTION_LABELS } from "@/lib/portal";
import { can } from "@/lib/roles";
import { requirePortal } from "@/server/portal";
import { BillingBadge } from "../billing/components";
import { StatusBadge } from "../jobs/components";
import { Nav } from "../nav";
import { ScopeNotice } from "./scope-notice";

/**
 * Portal tenant — Ringkasan (W6, read-only): layanan/environment + status, langganan (implementasi/garansi/aktif/lewat
 * jatuh tempo/ditangguhkan + tanggal), invoice terbuka (tenant-admin saja — ADR 0018 §Security: data finansial).
 * tenant-admin & tenant-user; cakupan = users.client_id sesi.
 */
export default async function PortalPage() {
  const { session, scope } = await requirePortal("portal:view");
  if (scope.kind !== "ok") {
    return (
      <>
        <Nav session={session} />
        <main className="space-y-4 p-6">
          <h1 className="text-lg font-semibold">Ringkasan</h1>
          <ScopeNotice scope={scope} />
        </main>
      </>
    );
  }
  const db = getDb();
  const t = scope.tenant;
  // ADR 0018 §Security: data finansial (invoice) hanya untuk tenant-admin — tenant-user tidak memuat/menampilkan invoice.
  const isAdmin = can(session.roles, "portal:admin");
  const [envs, subs, open] = await Promise.all([
    portalEnvironments(db, t.id),
    portalSubscriptions(db, t.id),
    isAdmin ? portalOpenInvoices(db, t.id) : Promise.resolve(null),
  ]);

  return (
    <>
      <Nav session={session} />
      <main className="space-y-6 p-6">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-lg font-semibold">{t.name}</h1>
          <span className="font-mono text-sm text-slate-500">({t.slug})</span>
          <StatusBadge value={t.status} />
        </div>
        {t.status === "suspended" ? (
          <p role="status" className="rounded bg-red-50 p-3 text-sm text-red-700">
            Layanan Odoo tenant ini sedang ditangguhkan karena tagihan lewat masa tenggang. Data tetap utuh; layanan aktif kembali
            setelah pembayaran dikonfirmasi.
          </p>
        ) : null}

        <section className="space-y-2">
          <h2 className="font-semibold">Layanan & environment</h2>
          <table className="w-full border bg-white text-left text-sm">
            <thead className="bg-slate-100">
              <tr>
                <th className="p-2">Environment</th>
                <th className="p-2">Alamat</th>
                <th className="p-2">Database</th>
                <th className="p-2">Route</th>
                <th className="p-2">SSO</th>
              </tr>
            </thead>
            <tbody>
              {envs.length === 0 ? (
                <tr>
                  <td colSpan={5} className="p-2 text-slate-500">
                    Belum ada environment.
                  </td>
                </tr>
              ) : (
                envs.map((e) => (
                  <tr key={e.id} className="border-t">
                    <td className="p-2 font-mono">{e.kind}</td>
                    <td className="p-2 font-mono">{e.host ? <a href={`https://${e.host}`} className="underline">{e.host}</a> : "—"}</td>
                    <td className="p-2">
                      <StatusBadge value={e.dbStatus} />
                    </td>
                    <td className="p-2">
                      <StatusBadge value={e.routeStatus} />
                    </td>
                    <td className="p-2">
                      <StatusBadge value={e.ssoStatus} />
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </section>

        <section className="space-y-2">
          <h2 className="font-semibold">Langganan</h2>
          {subs.length === 0 ? (
            <p className="text-sm text-slate-500">Belum ada langganan tercatat.</p>
          ) : (
            <table className="w-full border bg-white text-left text-sm">
              <thead className="bg-slate-100">
                <tr>
                  <th className="p-2">Paket</th>
                  <th className="p-2">Status</th>
                  <th className="p-2">Go-live</th>
                  <th className="p-2">Garansi s.d.</th>
                  <th className="p-2">Periode s.d.</th>
                  <th className="p-2">Tenggang s.d.</th>
                </tr>
              </thead>
              <tbody>
                {subs.map((s) => (
                  <tr key={s.id} className="border-t">
                    <td className="p-2">
                      {s.planName} <span className="text-xs text-slate-500">({s.service ?? "?"})</span>
                    </td>
                    <td className="p-2">
                      <BillingBadge value={s.status} />{" "}
                      <span className="text-xs text-slate-500">{PORTAL_SUBSCRIPTION_LABELS[s.status] ?? ""}</span>
                    </td>
                    <td className="p-2 whitespace-nowrap">{s.goLiveAt ?? "—"}</td>
                    <td className="p-2 whitespace-nowrap">{s.warrantyUntil ?? "—"}</td>
                    <td className="p-2 whitespace-nowrap">{s.endsAt ?? "—"}</td>
                    <td className="p-2 whitespace-nowrap">{s.graceUntil ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        {open ? (
          <section className="space-y-2">
            <h2 className="font-semibold">Invoice terbuka</h2>
            {open.length === 0 ? (
              <p className="text-sm text-slate-500">Tidak ada invoice terbuka.</p>
            ) : (
              <table className="w-full border bg-white text-left text-sm">
                <thead className="bg-slate-100">
                  <tr>
                    <th className="p-2">Nomor</th>
                    <th className="p-2">Jenis</th>
                    <th className="p-2">Jumlah</th>
                    <th className="p-2">Jatuh tempo</th>
                    <th className="p-2">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {open.map((i) => (
                    <tr key={i.id} className="border-t">
                      <td className="p-2 font-mono">{i.number}</td>
                      <td className="p-2">{i.kind === "implementation" ? "implementasi" : "maintenance"}</td>
                      <td className="p-2 whitespace-nowrap">{formatAmount(i.amount, i.currency)}</td>
                      <td className="p-2 whitespace-nowrap">{i.dueAt ?? "—"}</td>
                      <td className="p-2">
                        <BillingBadge value={i.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <p className="text-xs text-slate-500">Pembayaran via transfer; konfirmasi dilakukan oleh tim billing platform.</p>
          </section>
        ) : null}

        {isAdmin ? (
          <p className="text-sm">
            <Link href="/portal/users" className="underline">
              Kelola user tenant
            </Link>{" "}
            ·{" "}
            <Link href="/portal/domains" className="underline">
              Domain & checklist DNS
            </Link>
          </p>
        ) : null}
      </main>
    </>
  );
}
