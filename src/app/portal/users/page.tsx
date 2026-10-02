import { getDb } from "@/db";
import { portalAccess, portalEnvironments, portalUsers } from "@/db/portal-queries";
import { getWebEnv } from "@/env";
import { countTenantSeats, loadPlanLimit, userFeatureEnabled } from "@/jobs/users";
import { envAllowedForInstance, instanceJobTypes } from "@/lib/job-contract";
import { ACTION_RESULT_TEXT, parseActionResult } from "@/lib/job-list-params";
import { ROLE_LABELS } from "@/lib/roles";
import { requirePortal } from "@/server/portal";
import { ResultBanner, StatusBadge } from "../../jobs/components";
import { Nav } from "../../nav";
import { ScopeNotice } from "../scope-notice";
import {
  portalAddUserAction,
  portalChangeAccessAction,
  portalDisableUserAction,
  portalEnableUserAction,
  portalPasswordResetAction,
} from "./actions";

const btn = "rounded border px-3 py-1 text-sm hover:bg-slate-100 disabled:opacity-50";
const btnDanger = "rounded border border-red-300 px-3 py-1 text-sm text-red-700 hover:bg-red-50";
const input = "rounded border px-2 py-1 text-sm";

type Env = { id: string; kind: string };
type Access = { environmentId: string; email: string; status: string; isAdmin: boolean };

/** Akses Odoo per environment (none/user/admin) — nilai awal dari akses aktif. id env diverifikasi ulang di server. */
function OdooSelects({ envs, access, email }: { envs: Env[]; access: Access[]; email: string | null }) {
  if (envs.length === 0) return <span className="text-xs text-slate-500">tanpa environment Odoo</span>;
  return (
    <>
      {envs.map((e) => {
        const cur = email ? access.find((a) => a.environmentId === e.id && a.email === email) : undefined;
        const active = cur && (cur.status === "active" || cur.status === "revoked");
        // Portal hanya none|user (QA N5); akses admin yang ada dikelola admin platform — ditampilkan, tidak bisa dipilih.
        return (
          <label key={e.id} className="text-sm">
            Odoo <span className="font-mono">{e.kind}</span>{" "}
            <select name={`odoo_${e.id}`} defaultValue={active ? "user" : "none"} className={input}>
              <option value="none">tanpa akses</option>
              <option value="user">user</option>
            </select>
            {active && cur.isAdmin ? <span className="ml-1 text-xs text-amber-700">(saat ini admin)</span> : null}
          </label>
        );
      })}
    </>
  );
}

/**
 * Portal tenant — Users (W6, tenant-admin): user tenant sendiri; tambah (tenant-user saja), nonaktifkan/aktifkan,
 * kirim reset password, akses Odoo per environment. Batas jumlah user mengikuti paket langganan Odoo. Semua aturan
 * ditegakkan ulang di server (jobs/portal.ts); tombol di sini hanya kemudahan.
 */
export default async function PortalUsersPage(props: PageProps<"/portal/users">) {
  const { session, scope } = await requirePortal("portal:admin");
  const sp = await props.searchParams;
  const r = parseActionResult(sp.r);
  if (scope.kind !== "ok") {
    return (
      <>
        <Nav session={session} />
        <main className="space-y-4 p-6">
          <h1 className="text-lg font-semibold">Users</h1>
          <ScopeNotice scope={scope} />
        </main>
      </>
    );
  }
  const db = getDb();
  const t = scope.tenant;
  const env = getWebEnv();
  const instance = env.INFRA_JOBS_INSTANCE;
  const featureOn = instance !== undefined && userFeatureEnabled(instanceJobTypes(env.INFRA_JOBS_TYPES));
  const [rows, allEnvs, access, limit, used] = await Promise.all([
    portalUsers(db, t.id),
    portalEnvironments(db, t.id),
    portalAccess(db, t.id),
    loadPlanLimit(db, t.id),
    countTenantSeats(db, t.id),
  ]);
  const envs: Env[] = allEnvs.filter((e) => instance !== undefined && envAllowedForInstance(instance, e.kind));
  const full = limit.kind === "limited" && used >= limit.maxUsers;

  return (
    <>
      <Nav session={session} />
      <main className="space-y-6 p-6">
        <h1 className="text-lg font-semibold">
          Users <span className="font-mono text-sm text-slate-500">({t.slug})</span>
        </h1>
        {r ? <ResultBanner code={r} text={ACTION_RESULT_TEXT[r]} jobId={null} /> : null}
        <p className="text-sm text-slate-600">
          Kursi terpakai: <strong>{used}</strong>
          {limit.kind === "limited" ? ` dari ${limit.maxUsers} (paket ${limit.planCode})` : limit.kind === "unlimited" ? ` (paket ${limit.planCode}: tanpa batas)` : " (belum ada paket Odoo)"} —
          user aktif + undangan + yang sedang diproses.
        </p>
        {!featureOn ? (
          <p role="status" className="rounded bg-amber-50 p-3 text-sm text-amber-800">
            Pengelolaan user belum aktif di instance ini.
          </p>
        ) : null}

        <table className="w-full border bg-white text-left text-sm">
          <thead className="bg-slate-100">
            <tr>
              <th className="p-2">Email</th>
              <th className="p-2">Nama</th>
              <th className="p-2">Role</th>
              <th className="p-2">Status</th>
              <th className="p-2">Aksi</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={5} className="p-2 text-slate-500">
                  Belum ada user.
                </td>
              </tr>
            ) : (
              rows.map((u) => {
                // Hanya tenant-user lain yang bisa dikelola dari portal (bukan diri sendiri / tenant-admin / staf platform).
                const manageable = featureOn && u.role === "client_user" && u.id !== scope.userId;
                // Akses Odoo admin (diberikan admin platform) tidak diubah dari portal — hindari penurunan tak sengaja.
                const hasOdooAdmin = access.some((a) => a.email === u.email && a.isAdmin && a.status === "active");
                return (
                  <tr key={u.id} className="border-t align-top">
                    <td className="p-2 font-mono">{u.email ?? "—"}</td>
                    <td className="p-2">{u.displayName ?? "—"}</td>
                    <td className="p-2">{ROLE_LABELS[u.role]}</td>
                    <td className="p-2">
                      <StatusBadge value={u.status} />
                    </td>
                    <td className="space-y-2 p-2">
                      {manageable && u.status !== "disabled" ? (
                        <>
                          {hasOdooAdmin ? (
                            <p className="text-xs text-slate-500">Akses Odoo admin — diubah lewat admin platform.</p>
                          ) : (
                            <form action={portalChangeAccessAction} className="flex flex-wrap items-center gap-2">
                              <input type="hidden" name="userId" value={u.id} />
                              <OdooSelects envs={envs} access={access} email={u.email} />
                              <button type="submit" className={btn}>
                                Simpan akses
                              </button>
                            </form>
                          )}
                          <div className="flex flex-wrap gap-2">
                            <form action={portalPasswordResetAction}>
                              <input type="hidden" name="userId" value={u.id} />
                              <button type="submit" className={btn}>
                                Kirim reset password
                              </button>
                            </form>
                            <form action={portalDisableUserAction} className="flex items-center gap-1">
                              <input type="hidden" name="userId" value={u.id} />
                              <label className="text-xs">
                                <input type="checkbox" name="confirm" required /> yakin
                              </label>
                              <button type="submit" className={btnDanger}>
                                Nonaktifkan
                              </button>
                            </form>
                          </div>
                        </>
                      ) : null}
                      {manageable && u.status === "disabled" ? (
                        <form action={portalEnableUserAction} className="flex flex-wrap items-center gap-2">
                          <input type="hidden" name="userId" value={u.id} />
                          <OdooSelects envs={envs} access={access} email={u.email} />
                          <button type="submit" className={btn} disabled={full}>
                            Aktifkan
                          </button>
                        </form>
                      ) : null}
                      {!manageable ? <span className="text-xs text-slate-500">—</span> : null}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>

        {featureOn ? (
          <form action={portalAddUserAction} className="space-y-2 rounded border bg-white p-4 text-sm">
            <h2 className="font-semibold">Tambah user (tenant-user)</h2>
            <div className="flex flex-wrap items-center gap-2">
              <input name="email" type="email" required maxLength={254} placeholder="email" className={input} />
              <input name="name" maxLength={100} placeholder="nama (ASCII, opsional)" className={input} />
              <OdooSelects envs={envs} access={[]} email={null} />
              <button type="submit" className={btn} disabled={full}>
                Undang
              </button>
            </div>
            <p className="text-xs text-slate-500">
              User menerima email undangan untuk mengatur password. Menambah tenant-admin hanya lewat admin platform.
              {full ? " Batas user paket tercapai." : ""}
            </p>
          </form>
        ) : null}
      </main>
    </>
  );
}
