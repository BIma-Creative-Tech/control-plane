import Link from "next/link";
import { getDb } from "@/db";
import { listRealmSyncJobs, listUnboundUsers } from "@/db/tenant-queries";
import { getWebEnv } from "@/env";
import { platformTenant } from "@/jobs/tenants";
import { requirePermission } from "@/lib/authz";
import { APPROVE_ENVS, UUID_REGEX, instanceJobTypes, realmEnvForInstance } from "@/lib/job-contract";
import { ACTION_RESULT_TEXT, parseActionResult } from "@/lib/job-list-params";
import { ROLE_LABELS } from "@/lib/roles";
import { REALM_SYNC_TYPES, realmNameForEnv, typesEnabled } from "@/lib/tenant-onboarding";
import { ResultBanner, StatusBadge } from "../jobs/components";
import { Nav } from "../nav";
import { realmSyncApplyAction, realmSyncPlanAction } from "./actions";

const input = "rounded border px-2 py-1 text-sm";
const btn = "rounded border px-3 py-1 text-sm hover:bg-slate-100";
const btnDanger = "rounded border border-red-300 px-3 py-1 text-sm text-red-700 hover:bg-red-50";
const fmt = (d: Date | null) => (d ? d.toISOString().replace("T", " ").slice(0, 16) : "—");

/**
 * Sync realm (W5, ADR 0017 D7): "Rencana sync realm" (kc_realm_sync dry-run) → RESULT changed/blockers →
 * "Terapkan" (ketik nama realm; prod/demo + checkbox → approve=true). Superadmin (`realm:sync`). Setelah sync pertama:
 * adopsi staf lama tanpa tenant (keycloak.md §Adopsi user lama) lewat /users.
 */
export default async function RealmPage(props: PageProps<"/realm">) {
  const session = await requirePermission("realm:sync");
  const sp = await props.searchParams;
  const r = parseActionResult(sp.r);
  const chainParam = typeof sp.chain === "string" && UUID_REGEX.test(sp.chain) ? sp.chain : null;
  const env = getWebEnv();
  const instance = env.INFRA_JOBS_INSTANCE;
  const db = getDb();
  const platform = await platformTenant(db);
  const featureOn = instance !== undefined && platform !== null && typesEnabled(instanceJobTypes(env.INFRA_JOBS_TYPES), REALM_SYNC_TYPES);
  const realmEnv = instance ? realmEnvForInstance(instance) : null;
  const realm = realmEnv ? realmNameForEnv(realmEnv) : null;
  const needApprove = realmEnv !== null && APPROVE_ENVS.includes(realmEnv);
  const [jobs, unbound] = await Promise.all([platform ? listRealmSyncJobs(db, platform.id, 10) : Promise.resolve([]), listUnboundUsers(db)]);

  return (
    <>
      <Nav session={session} />
      <main className="space-y-6 p-6">
        <h1 className="text-lg font-semibold">
          Sync realm {realm ? <span className="font-mono text-slate-500">({realm})</span> : null}
        </h1>
        {r ? <ResultBanner code={r} text={ACTION_RESULT_TEXT[r]} jobId={null} /> : null}
        {!featureOn ? (
          <p role="status" className="rounded bg-amber-50 p-3 text-sm text-amber-800">
            Sync realm nonaktif di instance ini ({instance ?? "INFRA_JOBS_INSTANCE kosong"}): tipe{" "}
            <span className="font-mono">kc_realm_sync</span> tidak ada di allowlist atau tenant platform belum ada.
          </p>
        ) : (
          <section className="space-y-4 rounded border bg-white p-4 text-sm">
            <form action={realmSyncPlanAction} className="flex items-center gap-2">
              <button type="submit" className={btn}>
                Rencana sync realm
              </button>
              <span className="text-xs text-slate-500">
                kc_realm_sync dry-run, slug <span className="font-mono">platform</span>, env <span className="font-mono">{realmEnv}</span> — tidak
                mengubah apa pun.
              </span>
            </form>
            <form action={realmSyncApplyAction} className="flex flex-wrap items-center gap-2 border-t pt-4">
              <input name="confirm" required maxLength={64} autoComplete="off" placeholder={`ketik ${realm}`} className={input} />
              {needApprove ? (
                <label className="text-xs">
                  <input type="checkbox" name="approve" /> Saya menyetujui perubahan realm produksi (approve=true)
                </label>
              ) : null}
              <button type="submit" className={btnDanger}>
                Terapkan
              </button>
              <p className="w-full text-xs text-slate-500">
                Syarat: rencana terakhir sukses ≤ 24 jam dengan blockers=0. Realm prod/demo wajib persetujuan eksplisit.
              </p>
            </form>
          </section>
        )}

        <section className="space-y-2">
          <h2 className="font-semibold">Riwayat kc_realm_sync</h2>
          <table className="w-full border bg-white text-left text-sm">
            <thead className="bg-slate-100">
              <tr>
                <th className="p-2">Dibuat (UTC)</th>
                <th className="p-2">Mode</th>
                <th className="p-2">Env</th>
                <th className="p-2">Status</th>
                <th className="p-2">changed</th>
                <th className="p-2">blockers</th>
                <th className="p-2">approve</th>
              </tr>
            </thead>
            <tbody>
              {jobs.length === 0 ? (
                <tr>
                  <td colSpan={7} className="p-2 text-slate-500">
                    Belum ada.
                  </td>
                </tr>
              ) : (
                jobs.map((j) => {
                  const approve = (j.payload as { args?: { approve?: unknown } }).args?.approve === true;
                  return (
                    <tr key={j.id} className="border-t">
                      <td className="p-2 whitespace-nowrap">
                        <Link href={`/jobs/${j.id}`} className="underline">
                          {fmt(j.createdAt)}
                        </Link>
                      </td>
                      <td className="p-2 font-mono">{j.result?.mode ?? (j.dryRun ? "plan" : "apply")}</td>
                      <td className="p-2 font-mono">{j.env ?? "—"}</td>
                      <td className="p-2">
                        <StatusBadge value={j.status} />
                        {j.errorCode ? <span className="ml-1 font-mono text-xs text-red-700">{j.errorCode}</span> : null}
                      </td>
                      <td className="p-2 font-mono">{j.result?.changed ?? "—"}</td>
                      <td className={`p-2 font-mono ${j.result?.blockers && j.result.blockers !== "0" ? "text-red-700" : ""}`}>{j.result?.blockers ?? "—"}</td>
                      <td className="p-2">{approve ? "ya" : "—"}</td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
          {chainParam ? <p className="text-xs text-slate-500">Job baru ada di baris teratas setelah diproses dispatcher.</p> : null}
        </section>

        <section className="space-y-2">
          <h2 className="font-semibold">Adopsi staf lama (langkah pertama setelah sync pertama)</h2>
          <p className="text-sm text-slate-500">
            Baris <span className="font-mono">users</span> tanpa tenant (login sebelum Fase 1). Ikat staf platform ke tenant{" "}
            <span className="font-mono">platform</span> lewat aksi &quot;Ikat ke tenant…&quot; (kc_user_ensure adopt=true) di halaman Users.
          </p>
          <table className="w-full border bg-white text-left text-sm">
            <thead className="bg-slate-100">
              <tr>
                <th className="p-2">Email</th>
                <th className="p-2">Role cache</th>
                <th className="p-2">Status</th>
                <th className="p-2">Login terakhir (UTC)</th>
                <th className="p-2"></th>
              </tr>
            </thead>
            <tbody>
              {unbound.length === 0 ? (
                <tr>
                  <td colSpan={5} className="p-2 text-slate-500">
                    Tidak ada user tanpa tenant.
                  </td>
                </tr>
              ) : (
                unbound.map((u) => (
                  <tr key={u.id} className="border-t">
                    <td className="p-2 font-mono">{u.email ?? "— (tanpa email, login ulang dulu)"}</td>
                    <td className="p-2">{ROLE_LABELS[u.role]}</td>
                    <td className="p-2">
                      <StatusBadge value={u.status} />
                    </td>
                    <td className="p-2 whitespace-nowrap">{fmt(u.lastLoginAt)}</td>
                    <td className="p-2">
                      <Link href={`/users?tenant=none#user-${u.id}`} className="underline">
                        Ikat ke tenant…
                      </Link>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </section>
      </main>
    </>
  );
}
