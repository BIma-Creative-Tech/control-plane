import Link from "next/link";
import { notFound } from "next/navigation";
import { getWebEnv } from "@/env";
import { requirePermission } from "@/lib/authz";
import { INSTANCE_ENVS } from "@/lib/job-contract";
import { ACTION_RESULT_TEXT, parseActionResult } from "@/lib/job-list-params";
import { can } from "@/lib/roles";
import { isValidSlug } from "@/lib/slug";
import { getClientBySlug, listEnvironmentsForClient } from "@/server/queries";
import { ResultBanner, StatusBadge } from "../../jobs/components";
import { Nav } from "../../nav";
import { createEnvironmentAction } from "../actions";

export default async function ClientPage(props: PageProps<"/clients/[slug]">) {
  const session = await requirePermission("jobs:view");
  const { slug } = await props.params;
  if (!isValidSlug(slug)) notFound();
  const client = await getClientBySlug(slug);
  if (!client) notFound();
  const envs = await listEnvironmentsForClient(client.id);
  const r = parseActionResult((await props.searchParams).r);
  const instance = getWebEnv().INFRA_JOBS_INSTANCE;
  const kinds = instance ? INSTANCE_ENVS[instance] : (["prod", "demo", "staging"] as const);

  return (
    <>
      <Nav session={session} />
      <main className="space-y-4 p-6">
        <p className="text-xs text-slate-500">
          <Link href="/clients" className="underline">
            Clients
          </Link>
        </p>
        <h1 className="text-lg font-semibold">
          {client.name} <span className="font-mono text-slate-500">({client.slug})</span>
        </h1>
        {r ? <ResultBanner code={r} text={ACTION_RESULT_TEXT[r]} jobId={null} /> : null}
        <table className="w-full border bg-white text-left text-sm">
          <thead className="bg-slate-100">
            <tr>
              <th className="p-2">Env</th>
              <th className="p-2">DB</th>
              <th className="p-2">Host</th>
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
                  <td className="p-2 font-mono">
                    <Link href={`/environments/${e.id}`} className="underline">
                      {e.kind}
                    </Link>
                  </td>
                  <td className="p-2 font-mono">
                    {e.dbName} <StatusBadge value={e.dbStatus} />
                  </td>
                  <td className="p-2 font-mono">{e.host ?? "—"}</td>
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
        {can(session.roles, "clients:manage") ? (
          <form action={createEnvironmentAction} className="flex flex-wrap items-center gap-2 rounded border bg-white p-4 text-sm">
            <input type="hidden" name="clientId" value={client.id} />
            <span className="font-semibold">Tambah environment</span>
            <select name="kind" className="rounded border px-2 py-1">
              {kinds.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
            <input name="host" maxLength={253} placeholder="host (wajib untuk demo)" className="rounded border px-2 py-1" />
            <button type="submit" className="rounded border px-3 py-1 hover:bg-slate-100">
              Simpan
            </button>
          </form>
        ) : null}
      </main>
    </>
  );
}
