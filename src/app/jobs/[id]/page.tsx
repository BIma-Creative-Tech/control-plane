import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePermission } from "@/lib/authz";
import { UUID_REGEX } from "@/lib/job-contract";
import { ACTION_RESULT_TEXT, parseActionResult } from "@/lib/job-list-params";
import { can } from "@/lib/roles";
import { getJob } from "@/server/queries";
import { retryJobAction } from "../../environments/[id]/actions";
import { Nav } from "../../nav";
import { ResultBanner, StatusBadge } from "../components";

const fmt = (d: Date | null) => (d ? d.toISOString().replace("T", " ").slice(0, 19) : "—");

/**
 * Detail job. Yang ditampilkan: args tervalidasi, RESULT ter-allowlist (tanpa secret/secret_file — sudah
 * dibuang dispatcher & worker), tail teredaksi. Tidak ada secret yang pernah sampai ke CP (ADR 0009).
 */
export default async function JobPage(props: PageProps<"/jobs/[id]">) {
  const session = await requirePermission("jobs:view");
  const { id } = await props.params;
  if (!UUID_REGEX.test(id)) notFound();
  const job = await getJob(id);
  if (!job) notFound();
  const r = parseActionResult((await props.searchParams).r);
  const args = (job.payload as { args?: unknown }).args ?? job.payload;
  const retryable =
    (job.status === "failed" || job.status === "cancelled") &&
    job.environmentId !== null &&
    can(session.roles, job.errorCode === "timeout_state_unknown" ? "jobs:odoo_admin" : "jobs:odoo");

  return (
    <>
      <Nav session={session} />
      <main className="space-y-4 p-6">
        <p className="text-xs text-slate-500">
          <Link href="/jobs" className="underline">
            Jobs
          </Link>
          {job.environmentId ? (
            <>
              {" / "}
              <Link href={`/environments/${job.environmentId}`} className="underline">
                environment
              </Link>
            </>
          ) : null}
        </p>
        <h1 className="text-lg font-semibold">
          <span className="font-mono">{job.type}</span> {job.dryRun ? "(dry-run)" : ""} <StatusBadge value={job.status} />
        </h1>
        {r ? <ResultBanner code={r} text={ACTION_RESULT_TEXT[r]} jobId={null} /> : null}

        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 rounded border bg-white p-4 text-sm">
          <dt>ID</dt>
          <dd className="font-mono">{job.id}</dd>
          <dt>Client / env</dt>
          <dd className="font-mono">
            {job.clientSlug ?? "—"} / {job.env ?? "—"}
          </dd>
          <dt>Aktor</dt>
          <dd className="font-mono">{job.actor}</dd>
          <dt>Error</dt>
          <dd className="font-mono">
            {job.errorCode ?? "—"} {job.exitCode !== null ? `(exit ${job.exitCode})` : ""} {job.error ?? ""}
          </dd>
          <dt>Dibuat / dispatch / mulai / selesai</dt>
          <dd>
            {fmt(job.createdAt)} / {fmt(job.dispatchedAt)} / {fmt(job.startedAt)} / {fmt(job.finishedAt)}
          </dd>
          <dt>Deadline</dt>
          <dd>{fmt(job.deadlineAt)}</dd>
          {job.parentJobId ? (
            <>
              <dt>Ulangan dari</dt>
              <dd>
                <Link href={`/jobs/${job.parentJobId}`} className="font-mono underline">
                  {job.parentJobId}
                </Link>
              </dd>
            </>
          ) : null}
        </dl>

        <section>
          <h2 className="font-semibold">Argumen</h2>
          <pre className="overflow-x-auto rounded border bg-white p-3 text-xs">{JSON.stringify(args, null, 2)}</pre>
        </section>

        <section>
          <h2 className="font-semibold">RESULT</h2>
          {job.result && Object.keys(job.result).length > 0 ? (
            <table className="rounded border bg-white text-left text-sm">
              <tbody>
                {Object.entries(job.result).map(([k, v]) => (
                  <tr key={k} className="border-t">
                    <th className="p-2 font-mono font-normal text-slate-600">{k}</th>
                    <td className="p-2 font-mono">{v}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="text-sm text-slate-500">Belum ada.</p>
          )}
        </section>

        <section>
          <h2 className="font-semibold">Tail log (teredaksi)</h2>
          <pre className="max-h-96 overflow-auto rounded border bg-slate-900 p-3 text-xs text-slate-100">{job.log || "—"}</pre>
        </section>

        {retryable ? (
          <form action={retryJobAction}>
            <input type="hidden" name="jobId" value={job.id} />
            <button type="submit" className="rounded border px-3 py-1 text-sm hover:bg-slate-100">
              Ulangi (job baru)
            </button>
          </form>
        ) : null}
      </main>
    </>
  );
}
