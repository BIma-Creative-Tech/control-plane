import { requirePermission } from "@/lib/authz";
import { Nav } from "../nav";

export default async function DashboardPage() {
  const session = await requirePermission("dashboard:view");
  return (
    <>
      <Nav session={session} />
      <main className="p-6">
        <h1 className="text-lg font-semibold">Dashboard</h1>
        <p className="mt-2 text-slate-600">Belum ada data.</p>
      </main>
    </>
  );
}
