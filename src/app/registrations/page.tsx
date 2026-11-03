import { desc } from "drizzle-orm";
import { activeBctoneTenants } from "@/bctone/registration";
import { getDb } from "@/db";
import { bctoneRegistrations } from "@/db/schema";
import { getWebEnv } from "@/env";
import { INDUSTRY_LABEL, TIER_LABEL, moduleName, type BctoneTier, type Industry } from "@/lib/bctone-register";
import { requirePermission } from "@/lib/authz";
import { ACTION_RESULT_TEXT, parseActionResult } from "@/lib/job-list-params";
import { ResultBanner, StatusBadge } from "../jobs/components";
import { Nav } from "../nav";
import { approveRegistrationAction, rejectRegistrationAction, setRegistrationExemptAction } from "./actions";

/** BCT Admin › Registrasi BCTOne (BR-02 review, D-2 waitlist). superadmin. Email ditampilkan (data kontak calon klien). */
export const dynamic = "force-dynamic";

export default async function RegistrationsPage(props: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await requirePermission("clients:manage");
  const r = parseActionResult((await props.searchParams).r);
  const db = getDb();
  const env = getWebEnv();
  const [rows, active] = await Promise.all([
    db.select().from(bctoneRegistrations).orderBy(desc(bctoneRegistrations.createdAt)).limit(100),
    activeBctoneTenants(db),
  ]);
  const btn = "rounded border px-2 py-1 text-xs hover:bg-slate-100";
  return (
    <>
      <Nav session={session} />
      <main className="space-y-4 p-6">
        <h1 className="text-lg font-semibold">Registrasi BCTOne</h1>
        {r ? <ResultBanner code={r} text={ACTION_RESULT_TEXT[r]} jobId={null} /> : null}
        <p className="text-sm text-slate-600">
          Wizard publik: {env.BCTONE_REGISTER_ENABLED === "1" ? "aktif (/daftar)" : "nonaktif"} · tenant self-serve aktif {active}/{env.BCTONE_CAPACITY}
        </p>
        <table className="w-full border bg-white text-left text-sm">
          <thead className="bg-slate-100">
            <tr>
              <th className="p-2">Dibuat</th>
              <th className="p-2">Bisnis</th>
              <th className="p-2">Kebutuhan</th>
              <th className="p-2">Paket / AI</th>
              <th className="p-2">Status</th>
              <th className="p-2">Aksi</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={6} className="p-2 text-slate-500">
                  Belum ada registrasi.
                </td>
              </tr>
            ) : (
              rows.map((x) => (
                <tr key={x.id} className="border-t align-top">
                  <td className="p-2 whitespace-nowrap">{x.createdAt.toISOString().slice(0, 16).replace("T", " ")}</td>
                  <td className="p-2">
                    {x.businessName} <span className="font-mono text-xs text-slate-500">({x.slug})</span>
                    <span className="block text-xs text-slate-500">
                      {x.ownerName} · {x.email}
                    </span>
                  </td>
                  <td className="p-2 text-xs">
                    {x.industry ? `${INDUSTRY_LABEL[x.industry as Industry]} · ${x.outlets} outlet` : "—"}
                    {x.modules?.length ? <span className="block">{x.modules.map(moduleName).join(", ")}</span> : null}
                    {x.extraNeeds ? <span className="block text-violet-700">Lain: {x.extraNeeds}</span> : null}
                  </td>
                  <td className="p-2 text-xs">
                    {x.tier ? TIER_LABEL[x.tier as BctoneTier] : "—"} / {x.aiConsent ?? "—"}
                    {x.billingExempt ? <span className="block font-semibold text-emerald-700">Bebas tagihan</span> : null}
                  </td>
                  <td className="p-2">
                    <StatusBadge value={x.status} />
                    {x.reviewNote ? <span className="block text-xs text-slate-500">{x.reviewNote}</span> : null}
                  </td>
                  <td className="p-2">
                    {x.status === "review" || x.status === "waitlist" ? (
                      <div className="space-y-1">
                        <form action={setRegistrationExemptAction}>
                          <input type="hidden" name="id" value={x.id} />
                          <input type="hidden" name="exempt" value={x.billingExempt ? "false" : "true"} />
                          <button type="submit" className={btn}>
                            {x.billingExempt ? "Batalkan bebas tagihan" : "Tandai bebas tagihan"}
                          </button>
                        </form>
                        <form action={approveRegistrationAction}>
                          <input type="hidden" name="id" value={x.id} />
                          <button type="submit" className={btn}>
                            Setujui &amp; siapkan ERP
                          </button>
                        </form>
                        <form action={rejectRegistrationAction} className="flex gap-1">
                          <input type="hidden" name="id" value={x.id} />
                          <input name="note" required minLength={3} maxLength={500} placeholder="alasan" className="w-28 rounded border px-1 text-xs" />
                          <button type="submit" className={btn}>
                            Tolak
                          </button>
                        </form>
                      </div>
                    ) : null}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </main>
    </>
  );
}
