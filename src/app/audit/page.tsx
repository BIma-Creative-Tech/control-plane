import Link from "next/link";
import { getDb } from "@/db";
import { queryAudit } from "@/db/tenant-queries";
import { requirePermission } from "@/lib/authz";
import { AUDIT_PAGE_SIZE, AUDIT_RESULTS, auditPageHref, parseAuditParams, redactAuditMetadata } from "@/lib/audit-params";
import { listTenants } from "@/server/users-queries";
import { StatusBadge } from "../jobs/components";
import { Nav } from "../nav";

const input = "rounded border px-2 py-1";
const fmt = (d: Date) => d.toISOString().replace("T", " ").slice(0, 19);

/**
 * Audit (W5): audit_logs dengan filter aktor (prefix sub), tenant, aksi (prefix), hasil, rentang tanggal (hari WIB) +
 * paginasi. superadmin + ops (`audit:view`). Email TIDAK pernah ditampilkan: tidak join users.email, metadata
 * disamarkan (redactAuditMetadata) — audit menyimpan email_hash.
 */
export default async function AuditPage(props: PageProps<"/audit">) {
  const session = await requirePermission("audit:view");
  const p = parseAuditParams(await props.searchParams);
  const [{ rows, total }, tenants] = await Promise.all([queryAudit(getDb(), p), listTenants()]);
  const pages = Math.max(1, Math.ceil(total / AUDIT_PAGE_SIZE));

  return (
    <>
      <Nav session={session} />
      <main className="space-y-4 p-6">
        <h1 className="text-lg font-semibold">Audit</h1>
        <form method="get" className="flex flex-wrap items-end gap-2 text-sm">
          <label className="flex flex-col">
            Aktor (prefix sub)
            <input name="actor" defaultValue={p.raw.actor ?? ""} maxLength={140} placeholder="mis. 6b1f0e2a atau system:worker" className={input} />
          </label>
          <label className="flex flex-col">
            Tenant
            <select name="tenant" defaultValue={p.raw.tenant ?? ""} className={input}>
              <option value="">semua</option>
              {tenants.map((t) => (
                <option key={t.id} value={t.slug}>
                  {t.slug}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col">
            Aksi (prefix)
            <input name="action" defaultValue={p.raw.action ?? ""} maxLength={64} placeholder="mis. tenant. / job.enqueue" className={input} />
          </label>
          <label className="flex flex-col">
            Hasil
            <select name="result" defaultValue={p.raw.result ?? ""} className={input}>
              <option value="">semua</option>
              {AUDIT_RESULTS.map((x) => (
                <option key={x} value={x}>
                  {x}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col">
            Dari (WIB)
            <input type="date" name="from" defaultValue={p.raw.from ?? ""} className={input} />
          </label>
          <label className="flex flex-col">
            Sampai (WIB)
            <input type="date" name="to" defaultValue={p.raw.to ?? ""} className={input} />
          </label>
          <button type="submit" className="rounded border px-3 py-1">
            Filter
          </button>
          <Link href="/audit" className="px-2 py-1 underline">
            Reset
          </Link>
        </form>

        <table className="w-full border bg-white text-left text-sm">
          <thead className="bg-slate-100">
            <tr>
              <th className="p-2">Waktu (UTC)</th>
              <th className="p-2">Aktor</th>
              <th className="p-2">Aksi</th>
              <th className="p-2">Tenant</th>
              <th className="p-2">Target</th>
              <th className="p-2">Hasil</th>
              <th className="p-2">Detail</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={7} className="p-2 text-slate-500">
                  Tidak ada entri.
                </td>
              </tr>
            ) : (
              rows.map((a) => (
                <tr key={String(a.id)} className="border-t align-top">
                  <td className="p-2 whitespace-nowrap">{fmt(a.occurredAt)}</td>
                  <td className="p-2 font-mono text-xs break-all">{a.actor}</td>
                  <td className="p-2 font-mono text-xs">{a.action}</td>
                  <td className="p-2 font-mono">{a.tenant ?? "—"}</td>
                  <td className="p-2 font-mono text-xs break-all">
                    {a.targetType ?? "—"}
                    {a.targetId ? `:${a.targetId}` : ""}
                  </td>
                  <td className="p-2">
                    <StatusBadge value={a.result} />
                  </td>
                  <td className="p-2">
                    <details>
                      <summary className="cursor-pointer text-xs underline">metadata</summary>
                      <pre className="max-w-xl overflow-x-auto text-xs whitespace-pre-wrap">
                        {JSON.stringify(redactAuditMetadata(a.metadata), null, 1)}
                      </pre>
                      <p className="text-xs text-slate-500">
                        ip {a.ip ?? "—"} · req {a.requestId ?? "—"}
                      </p>
                    </details>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
        <nav className="flex items-center gap-3 text-sm" aria-label="Halaman audit">
          {p.page > 1 ? (
            <Link href={auditPageHref(p, p.page - 1)} className="underline">
              ← Sebelumnya
            </Link>
          ) : null}
          <span className="text-slate-500">
            Halaman {p.page} / {pages} · {total} entri · {AUDIT_PAGE_SIZE}/halaman
          </span>
          {p.page < pages ? (
            <Link href={auditPageHref(p, p.page + 1)} className="underline">
              Berikutnya →
            </Link>
          ) : null}
        </nav>
      </main>
    </>
  );
}
