import { requirePermission } from "@/lib/authz";
import { ACTION_RESULT_TEXT, ALL_JOB_TYPES, JOB_STATUSES, parseActionResult, parseJobListParams } from "@/lib/job-list-params";
import { JOB_PAGE_SIZE, listJobs } from "@/server/queries";
import { Nav } from "../nav";
import { JobTable, ResultBanner } from "./components";

export default async function JobsPage(props: PageProps<"/jobs">) {
  const session = await requirePermission("jobs:view");
  const sp = await props.searchParams;
  const params = parseJobListParams(sp);
  const r = parseActionResult(sp.r);
  const rows = await listJobs(params);

  return (
    <>
      <Nav session={session} />
      <main className="space-y-4 p-6">
        <h1 className="text-lg font-semibold">Jobs</h1>
        {r ? <ResultBanner code={r} text={ACTION_RESULT_TEXT[r]} jobId={null} /> : null}
        <form method="get" className="flex flex-wrap gap-2 text-sm">
          <input
            name="client"
            defaultValue={params.client ?? ""}
            maxLength={30}
            pattern="[a-z0-9-]{3,30}"
            placeholder="slug client"
            className="rounded border px-2 py-1"
          />
          <select name="status" defaultValue={params.status ?? ""} className="rounded border px-2 py-1">
            <option value="">semua status</option>
            {JOB_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <select name="type" defaultValue={params.type ?? ""} className="rounded border px-2 py-1">
            <option value="">semua tipe</option>
            {ALL_JOB_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <button type="submit" className="rounded border px-3 py-1">
            Filter
          </button>
        </form>
        <JobTable rows={rows} />
        <p className="text-xs text-slate-500">
          Halaman {params.page} · {JOB_PAGE_SIZE}/halaman
        </p>
      </main>
    </>
  );
}
