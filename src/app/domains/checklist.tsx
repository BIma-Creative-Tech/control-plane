import { dnsChecklist, type DomainPurpose } from "@/lib/domains";

/**
 * Checklist DNS satu domain (tampilan saja, tanpa data/aksi) — dipakai halaman tenant (platform) dan /portal/domains.
 * Nilai dari lib/domains.ts dnsChecklist; IP dari env PLATFORM_PUBLIC_IPV4 (server).
 */
export function DnsChecklistTable({ fqdn, purpose, dkimTxt, platformIpv4 }: { fqdn: string; purpose: DomainPurpose | null; dkimTxt: string | null; platformIpv4: string | null }) {
  const c = dnsChecklist({ fqdn, purpose, dkimTxt }, platformIpv4);
  return (
    <div className="space-y-1">
      {c.records.length > 0 ? (
        <table className="w-full border text-left text-xs">
          <thead className="bg-slate-50">
            <tr>
              <th className="p-1.5">Tipe</th>
              <th className="p-1.5">Nama</th>
              <th className="p-1.5">Prioritas</th>
              <th className="p-1.5">Nilai</th>
            </tr>
          </thead>
          <tbody>
            {c.records.map((r) => (
              <tr key={`${r.type}-${r.name}-${r.value ?? r.pending}`} className="border-t align-top">
                <td className="p-1.5 font-mono">{r.type}</td>
                <td className="p-1.5 font-mono break-all">
                  {r.host} <span className="text-slate-400">({r.name})</span>
                </td>
                <td className="p-1.5 font-mono">{r.priority ?? "—"}</td>
                <td className="p-1.5 font-mono break-all">{r.value ?? <span className="text-amber-700">{r.pending}</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      <ul className="list-disc pl-5 text-xs text-slate-500">
        {c.notes.map((n) => (
          <li key={n}>{n}</li>
        ))}
        <li>Verifikasi otomatis: Fase 2.</li>
      </ul>
    </div>
  );
}
