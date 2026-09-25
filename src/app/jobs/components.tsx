import Link from "next/link";

const TONE: Record<string, string> = {
  succeeded: "bg-green-100 text-green-800",
  active: "bg-green-100 text-green-800",
  provisioned: "bg-green-100 text-green-800",
  failed: "bg-red-100 text-red-800",
  revoked: "bg-slate-200 text-slate-700",
  removed: "bg-slate-200 text-slate-700",
  disabled: "bg-slate-200 text-slate-700",
  running: "bg-blue-100 text-blue-800",
  dispatched: "bg-blue-100 text-blue-800",
  queued: "bg-amber-100 text-amber-800",
  pending: "bg-amber-100 text-amber-800",
};

export function StatusBadge({ value }: { value: string }) {
  return <span className={`rounded px-1.5 py-0.5 text-xs ${TONE[value] ?? "bg-slate-100 text-slate-700"}`}>{value}</span>;
}

export function ResultBanner({ code, text, jobId }: { code: string; text: string; jobId: string | null }) {
  const ok = code === "queued" || code === "created";
  return (
    <p role="status" className={`rounded p-3 text-sm ${ok ? "bg-green-50 text-green-800" : "bg-red-50 text-red-700"}`}>
      {text}{" "}
      {jobId ? (
        <Link href={`/jobs/${jobId}`} className="underline">
          Lihat job
        </Link>
      ) : null}
    </p>
  );
}

export interface JobRow {
  id: string;
  type: string;
  status: string;
  env: string | null;
  dryRun: boolean;
  errorCode: string | null;
  exitCode: number | null;
  actor: string;
  createdAt: Date;
  finishedAt: Date | null;
  clientSlug: string | null;
}

const fmt = (d: Date | null) => (d ? d.toISOString().replace("T", " ").slice(0, 19) : "—");

export function JobTable({ rows }: { rows: JobRow[] }) {
  return (
    <table className="w-full border bg-white text-left text-sm">
      <thead className="bg-slate-100">
        <tr>
          <th className="p-2">Dibuat (UTC)</th>
          <th className="p-2">Client</th>
          <th className="p-2">Env</th>
          <th className="p-2">Tipe</th>
          <th className="p-2">Status</th>
          <th className="p-2">Error</th>
          <th className="p-2">Selesai</th>
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 ? (
          <tr>
            <td colSpan={7} className="p-2 text-slate-500">
              Belum ada job.
            </td>
          </tr>
        ) : (
          rows.map((j) => (
            <tr key={j.id} className="border-t">
              <td className="p-2 whitespace-nowrap">
                <Link href={`/jobs/${j.id}`} className="underline">
                  {fmt(j.createdAt)}
                </Link>
              </td>
              <td className="p-2 font-mono">{j.clientSlug ?? "—"}</td>
              <td className="p-2 font-mono">{j.env ?? "—"}</td>
              <td className="p-2 font-mono">
                {j.type}
                {j.dryRun ? " (dry-run)" : ""}
              </td>
              <td className="p-2">
                <StatusBadge value={j.status} />
              </td>
              <td className="p-2 font-mono text-xs">
                {j.errorCode ?? ""}
                {j.exitCode !== null && j.exitCode !== 0 ? ` exit=${j.exitCode}` : ""}
              </td>
              <td className="p-2 whitespace-nowrap">{fmt(j.finishedAt)}</td>
            </tr>
          ))
        )}
      </tbody>
    </table>
  );
}
