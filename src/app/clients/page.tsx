import { requirePermission } from "@/lib/authz";
import { parseClientListParams } from "@/lib/client-list-params";
import { Nav } from "../nav";
import { PAGE_SIZE, listClients } from "./query";

export default async function ClientsPage(props: PageProps<"/clients">) {
  const session = await requirePermission("clients:list");
  const params = parseClientListParams(await props.searchParams);
  const { rows, total } = await listClients(params);

  return (
    <>
      <Nav session={session} />
      <main className="p-6">
        <h1 className="text-lg font-semibold">Clients</h1>
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
                  <td className="p-2 font-mono">{c.slug}</td>
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
      </main>
    </>
  );
}
