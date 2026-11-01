import { getDb } from "@/db";
import { portalBctone } from "@/db/portal-queries";
import { jakartaDate } from "@/lib/billing";
import { QUOTA_METRICS, quotaHardStop, quotaState, type QuotaMetric, type QuotaState } from "@/lib/bctone-quota";
import { ACTION_RESULT_TEXT, parseActionResult } from "@/lib/job-list-params";
import { can } from "@/lib/roles";
import { requirePortal } from "@/server/portal";
import { ResultBanner } from "../../jobs/components";
import { Nav } from "../../nav";
import { ScopeNotice } from "../scope-notice";
import { portalAiConsentAction } from "./actions";

/**
 * Console BCTOne (BR-08..12, US-13): Beranda kuota (pemakaian terakhir dari agen tenant vs batas paket) + Privasi
 * (consent AI). Semua user tenant melihat kuota; hanya tenant-admin yang bisa mengubah consent. Tenant dari sesi.
 */
export const dynamic = "force-dynamic";

const LABEL: Record<QuotaMetric, string> = {
  users: "Pengguna",
  devices: "Perangkat kasir",
  outlets: "Outlet",
  trx_per_month: "Transaksi bulan ini",
  omzet_per_month: "Omzet bulan ini (Rp)",
  ai_prompts_per_day: "Prompt AI hari ini",
};
const STATE: Record<QuotaState, { text: string; cls: string }> = {
  ok: { text: "Aman", cls: "bg-green-100 text-green-800" },
  warn: { text: "Hampir penuh", cls: "bg-amber-100 text-amber-800" },
  grace: { text: "Masa tenggang", cls: "bg-orange-100 text-orange-800" },
  blocked: { text: "Penuh", cls: "bg-red-100 text-red-800" },
};
const fmt = (n: number) => new Intl.NumberFormat("id-ID").format(n);

export default async function PortalBctonePage(props: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { session, scope } = await requirePortal("portal:view");
  if (scope.kind !== "ok") {
    return (
      <>
        <Nav session={session} />
        <main className="space-y-4 p-6">
          <h1 className="text-lg font-semibold">BCTOne</h1>
          <ScopeNotice scope={scope} />
        </main>
      </>
    );
  }
  const r = parseActionResult((await props.searchParams).r);
  const isAdmin = can(session.roles, "portal:admin");
  const data = await portalBctone(getDb(), scope.tenant.id, jakartaDate(new Date()));
  const used = (m: QuotaMetric): number | null => {
    if (m === "ai_prompts_per_day") return data?.aiToday ?? 0;
    const u = data?.usage;
    if (!u) return null;
    return { users: u.users, devices: u.devices, outlets: u.outlets, trx_per_month: u.trxMonthGross, omzet_per_month: Math.floor(Number(u.omzetMonthNet)) }[m];
  };
  return (
    <>
      <Nav session={session} />
      <main className="space-y-6 p-6">
        <h1 className="text-lg font-semibold">BCTOne — {scope.tenant.name}</h1>
        {r ? <ResultBanner code={r} text={ACTION_RESULT_TEXT[r]} jobId={null} /> : null}
        {!data ? (
          <p className="text-sm text-slate-500">Tenant ini belum memakai paket BCTOne.</p>
        ) : (
          <>
            <section className="space-y-2">
              <h2 className="font-semibold">
                Paket {data.plan.name} <span className="font-mono text-xs text-slate-500">({data.plan.code})</span>
              </h2>
              <p className="text-xs text-slate-500">
                Status {data.plan.status}
                {data.plan.endsAt ? ` · periode s.d. ${data.plan.endsAt}` : ""}
                {data.usage ? ` · laporan terakhir ${data.usage.usageDate} (seq ${data.usage.seq})` : " · belum ada laporan pemakaian dari ERP"}
              </p>
              <table className="w-full border bg-white text-left text-sm" data-testid="bctone-quota">
                <thead className="bg-slate-100">
                  <tr>
                    <th className="p-2">Kuota</th>
                    <th className="p-2 text-right">Terpakai</th>
                    <th className="p-2 text-right">Batas</th>
                    <th className="p-2">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {QUOTA_METRICS.map((m) => {
                    const limit = data.limits[m] ?? null;
                    const u = used(m);
                    const st = u === null ? null : quotaState(m, limit, u);
                    return (
                      <tr key={m} className="border-t">
                        <td className="p-2">{LABEL[m]}</td>
                        <td className="p-2 text-right tabular-nums">{u === null ? "—" : fmt(u)}</td>
                        <td className="p-2 text-right tabular-nums">
                          {limit === null ? "tanpa batas" : fmt(limit)}
                          {limit !== null && quotaHardStop(m, limit) !== limit ? (
                            <span className="block text-xs text-slate-500">tenggang s.d. {fmt(quotaHardStop(m, limit))}</span>
                          ) : null}
                        </td>
                        <td className="p-2">{st ? <span className={`rounded px-2 py-0.5 text-xs ${STATE[st].cls}`}>{STATE[st].text}</span> : "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </section>

            <section className="space-y-2" id="privasi">
              <h2 className="font-semibold">Privasi — penggunaan AI</h2>
              <p className="text-sm">
                Saat ini:{" "}
                <strong>
                  {data.consent === "allow"
                    ? "Diizinkan — prompt diproses Claude (Anthropic) melalui gateway BCT"
                    : data.consent === "deny"
                      ? "Tidak diizinkan — prompt hanya diproses model lokal di server BCT (Indonesia), tanpa layanan pihak ketiga"
                      : "Belum memilih — fitur AI nonaktif"}
                </strong>
              </p>
              {isAdmin ? (
                <form action={portalAiConsentAction} className="space-y-2 rounded border bg-white p-4 text-sm">
                  <fieldset className="space-y-1">
                    <legend className="font-medium">Pilih salah satu (tidak ada pilihan bawaan)</legend>
                    <label className="flex gap-2">
                      <input type="radio" name="consent" value="allow" required />
                      Izinkan: data prompt (sudah disamarkan: email, nomor HP, NIK) dikirim ke Claude untuk hasil terbaik.
                    </label>
                    <label className="flex gap-2">
                      <input type="radio" name="consent" value="deny" required />
                      Tidak izinkan: hanya model lokal di server BCT; jawaban lebih sederhana, tidak pernah dialihkan ke Claude.
                    </label>
                  </fieldset>
                  <label className="flex gap-2">
                    <input type="checkbox" name="confirm" required />
                    Saya berwenang memutuskan ini untuk {scope.tenant.name}.
                  </label>
                  <button type="submit" className="rounded bg-slate-900 px-3 py-1 font-medium text-white">
                    Simpan pilihan
                  </button>
                  <p className="text-xs text-slate-500">Setiap perubahan tercatat permanen (hash-chain) dan berlaku mulai permintaan AI berikutnya.</p>
                </form>
              ) : (
                <p className="text-xs text-slate-500">Hanya admin tenant yang dapat mengubah pilihan ini.</p>
              )}
              {data.history.length > 0 ? (
                <ul className="text-xs text-slate-500">
                  {data.history.map((h) => (
                    <li key={h.hash} className="font-mono">
                      {h.createdAt.toISOString().slice(0, 19).replace("T", " ")} UTC · {h.consent} · {h.hash.slice(0, 12)}…
                    </li>
                  ))}
                </ul>
              ) : null}
            </section>
          </>
        )}
      </main>
    </>
  );
}
