import { getDb } from "@/db";
import { portalDomains } from "@/db/portal-queries";
import { getWebEnv } from "@/env";
import { requirePortal } from "@/server/portal";
import { DnsChecklistTable } from "../../domains/checklist";
import { StatusBadge } from "../../jobs/components";
import { Nav } from "../../nav";
import { ScopeNotice } from "../scope-notice";

/**
 * Portal tenant — Domain & Mail (W6, tenant-admin, READ-ONLY Fase 1): domain tenant sendiri + kegunaan + status
 * verifikasi + checklist DNS yang digenerate (lib/domains.ts). Perubahan data domain dilakukan admin platform.
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
  const platformIpv4 = getWebEnv().PLATFORM_PUBLIC_IPV4 ?? null;
  return (
    <>
      <Nav session={session} />
      <main className="space-y-6 p-6">
        <h1 className="text-lg font-semibold">
          Domain <span className="font-mono text-sm text-slate-500">({scope.tenant.slug})</span>
        </h1>
        <p className="text-sm text-slate-600">
          Pasang record DNS berikut di penyedia DNS domain Anda. Data domain dikelola admin platform; verifikasi otomatis: Fase 2.
        </p>
        {rows.length === 0 ? <p className="text-sm text-slate-500">Belum ada domain.</p> : null}
        {rows.map((d) => (
          <section key={d.id} className="space-y-2 rounded border bg-white p-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono font-semibold">{d.fqdn}</span>
              <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs">{d.purpose ?? "—"}</span>
              {d.envKind ? <span className="font-mono text-xs text-slate-500">env {d.envKind}</span> : null}
              <StatusBadge value={d.status} />
            </div>
            <DnsChecklistTable fqdn={d.fqdn} purpose={d.purpose} dkimTxt={d.dkimTxt} platformIpv4={platformIpv4} />
          </section>
        ))}
      </main>
    </>
  );
}
