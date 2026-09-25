import Link from "next/link";
import { requirePermission } from "@/lib/authz";
import { parseClientListParams } from "@/lib/client-list-params";
import { ACTION_RESULT_TEXT, parseActionResult } from "@/lib/job-list-params";
import { can } from "@/lib/roles";
import { ResultBanner } from "../jobs/components";
import { Nav } from "../nav";
import { createClientAction } from "./actions";
import { PAGE_SIZE, listClients } from "./query";

export default async function ClientsPage(props: PageProps<"/clients">) {
  const session = await requirePermission("clients:list");
  const sp = await props.searchParams;
  const params = parseClientListParams(sp);
  const r = parseActionResult(sp.r);
  const { rows, total } = await listClients(params);

  return (
    <>
      <Nav session={session} />
      <main className="p-6">
        <h1 className="text-lg font-semibold">Clients</h1>
        {r ? <ResultBanner code={r} text={ACTION_RESULT_TEXT[r]} jobId={null} /> : null}
        <form className="my-4 flex gap-2" method="get">
          <input
            name="q"
            defaultValue={params.q ?? ""}
            maxLength={30}
            pattern="[a-z0-9-]{1,30}"
            placeholder="cari slug"
            className="rounded border px-2 py-1"
          />
          <button type="submit" className="rounded border px-3 py-1">
            Cari
          </button>
        </form>
        <table className="w-full border bg-white text-left text-sm">
          <thead className="bg-slate-100">
            <tr>
              <th className="p-2">Slug</th>
              <th className="p-2">Nama</th>
              <th className="p-2">Dibuat</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={3} className="p-2 text-slate-500">
                  Belum ada client.
                </td>
              </tr>
            ) : (
              rows.map((c) => (
                <tr key={c.id} className="border-t">
                  <td className="p-2 font-mono">
                    <Link href={`/clients/${c.slug}`} className="underline">
                      {c.slug}
                    </Link>
                  </td>
                  <td className="p-2">{c.name}</td>
                  <td className="p-2">{c.createdAt.toISOString().slice(0, 10)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
        <p className="mt-2 text-xs text-slate-500">
          Total {total} · halaman {params.page} · {PAGE_SIZE}/halaman
        </p>
        {can(session.roles, "clients:manage") ? (
          <form action={createClientAction} className="mt-4 flex flex-wrap items-center gap-2 rounded border bg-white p-4 text-sm">
            <span className="font-semibold">Tambah client</span>
            <input name="slug" required maxLength={30} pattern="[a-z0-9-]{3,30}" placeholder="slug" className="rounded border px-2 py-1" />
            <input name="name" required maxLength={200} placeholder="nama" className="rounded border px-2 py-1" />
            <button type="submit" className="rounded border px-3 py-1 hover:bg-slate-100">
              Simpan
            </button>
          </form>
        ) : null}
      </main>
    </>
  );
}
