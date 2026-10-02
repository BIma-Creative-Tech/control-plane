import { getDb } from "@/db";
import { portalDomains } from "@/db/portal-queries";
import { requirePortal } from "@/server/portal";
import { StatusBadge } from "../../jobs/components";
import { Nav } from "../../nav";
import { ScopeNotice } from "../scope-notice";

/**
 * Portal tenant — Domain & Mail (W6, tenant-admin, READ-ONLY Fase 1): domain tenant sendiri + kegunaan + status
 * verifikasi. Perubahan data domain dilakukan admin platform.
 */
export default async function PortalDomainsPage() {
  const { session, scope } = await requirePortal("portal:admin");
  if (scope.kind !== "ok") {
    return (
      <>
        <Nav session={session} />
        <main className="space-y-4 p-6">
          <h1 className="text-lg font-semibold">Domain</h1>
          <ScopeNotice scope={scope} />
        </main>
      </>
    );
  }
  const rows = await portalDomains(getDb(), scope.tenant.id);
  return (
    <>
      <Nav session={session} />
      <main className="space-y-6 p-6">
        <h1 className="text-lg font-semibold">
          Domain <span className="font-mono text-sm text-slate-500">({scope.tenant.slug})</span>
        </h1>
        <p className="text-sm text-slate-600">Data domain dikelola admin platform. Verifikasi otomatis: Fase 2.</p>
        <table className="w-full border bg-white text-left text-sm">
          <thead className="bg-slate-100">
            <tr>
              <th className="p-2">Domain</th>
              <th className="p-2">Kegunaan</th>
              <th className="p-2">Environment</th>
              <th className="p-2">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={4} className="p-2 text-slate-500">
                  Belum ada domain.
                </td>
              </tr>
            ) : (
              rows.map((d) => (
                <tr key={d.id} className="border-t">
                  <td className="p-2 font-mono">{d.fqdn}</td>
                  <td className="p-2">{d.purpose ?? "—"}</td>
                  <td className="p-2 font-mono">{d.envKind ?? "—"}</td>
                  <td className="p-2">
                    <StatusBadge value={d.status} />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </main>
    </>
  );
}
