import Link from "next/link";
import { getWebEnv } from "@/env";
import { userFeatureEnabled } from "@/jobs/users";
import { requirePermission } from "@/lib/authz";
import { UUID_REGEX, cpRolesForSlug, envAllowedForInstance, instanceJobTypes, type CpRoleArg } from "@/lib/job-contract";
import { ACTION_RESULT_TEXT, parseActionResult } from "@/lib/job-list-params";
import { ROLE_LABELS, can, isRole } from "@/lib/roles";
import { SLUG_REGEX } from "@/lib/slug";
import { listAccessByEnvs, listEnvsByClient, listRecentChains, listTenants, listUsers } from "@/server/users-queries";
import { ResultBanner, StatusBadge } from "../jobs/components";
import { Nav } from "../nav";
import { isPlatformRole } from "@/lib/user-admin";
import { addUserAction, adoptUserAction, changeUserAccessAction, disableUserAction, enableUserAction, passwordResetAction } from "./actions";

const btn = "rounded border px-3 py-1 text-sm hover:bg-slate-100 disabled:opacity-50";
const btnDanger = "rounded border border-red-300 px-3 py-1 text-sm text-red-700 hover:bg-red-50";
const input = "rounded border px-2 py-1 text-sm";
const fmt = (d: Date | null) => (d ? d.toISOString().replace("T", " ").slice(0, 16) : "—");

function roleLabel(r: CpRoleArg | string): string {
  if (r === "none") return "tanpa akses CP";
  return isRole(r) ? `${ROLE_LABELS[r]} (${r})` : r;
}

type EnvRow = Awaited<ReturnType<typeof listEnvsByClient>>[number];
type TenantRow = Awaited<ReturnType<typeof listTenants>>[number];

/**
 * "Ikat ke tenant…" (temuan QA F1.4/F8) untuk baris lama `client_id IS NULL` — superadmin saja. Role cache
 * superadmin/ops → hanya tenant platform dengan role tetap; role cache tenant → hanya tenant klien
 * (tenant-admin/tenant-user). Server mengulang semua cek (authorizeAdopt + aturan email).
 */
function AdoptForm({ user, tenants, back }: { user: { id: string; role: string }; tenants: TenantRow[]; back: string }) {
  const platformRole = isRole(user.role) && isPlatformRole(user.role);
  const options = tenants.filter((t) => !t.terminatedAt && (platformRole ? t.isPlatform : !t.isPlatform));
  if (options.length === 0) return <span className="text-xs text-slate-500">tidak ada tenant tujuan yang cocok</span>;
  return (
    <details>
      <summary className="cursor-pointer text-xs underline">Ikat ke tenant…</summary>
      <form action={adoptUserAction} className="mt-2 flex flex-wrap items-center gap-2">
        <input type="hidden" name="back" value={back} />
        <input type="hidden" name="userId" value={user.id} />
        <select name="clientId" className={input} required>
          {options.map((t) => (
            <option key={t.id} value={t.id}>
              {t.slug}
              {t.isPlatform ? " (internal)" : ""}
            </option>
          ))}
        </select>
        {platformRole ? (
          <>
            <input type="hidden" name="cp_role" value={user.role} />
            <span className="text-xs">role tetap: {roleLabel(user.role)}</span>
          </>
        ) : (
          <select name="cp_role" defaultValue="client_user" className={input}>
            <option value="client_user">{roleLabel("client_user")}</option>
            <option value="client_admin">{roleLabel("client_admin")}</option>
          </select>
        )}
        <button type="submit" className={btn}>
          Ikat
        </button>
        <p className="w-full text-xs text-slate-500">
          Rantai job: kc_user_ensure (adopt, tanpa undangan) → kc_user_set_roles. Tenant user tercatat setelah job sukses.
        </p>
      </form>
    </details>
  );
}
type AccessRow = Awaited<ReturnType<typeof listAccessByEnvs>>[number];

/** Select akses Odoo per environment (nilai awal dari akses aktif saat ini). */
function OdooSelects({ envs, access, email }: { envs: EnvRow[]; access: AccessRow[]; email: string | null }) {
  if (envs.length === 0) return <span className="text-xs text-slate-500">tanpa environment Odoo di instance ini</span>;
  return (
    <>
      {envs.map((e) => {
        const cur = email ? access.find((a) => a.environmentId === e.environmentId && a.email === email) : undefined;
        const def = cur && (cur.status === "active" || cur.status === "revoked") ? (cur.isTenantAdmin ? "admin" : "user") : "none";
        return (
          <label key={e.environmentId} className="text-sm">
            Odoo <span className="font-mono">{e.kind}</span>{" "}
            <select name={`odoo_${e.environmentId}`} defaultValue={def} className={input}>
              <option value="none">none</option>
              <option value="user">user</option>
              <option value="admin">admin</option>
            </select>
          </label>
        );
      })}
    </>
  );
}

/**
 * Users (kontrak SaaS Fase 1 §2.3): daftar user semua tenant (termasuk `platform`) + rantai job per langkah.
 * Lihat: superadmin/ops (`users:view`); aksi: superadmin (`users:manage`). Otorisasi ulang di setiap Server Action.
 */
export default async function UsersPage(props: PageProps<"/users">) {
  const session = await requirePermission("users:view");
  const sp = await props.searchParams;
  const r = parseActionResult(sp.r);
  const rawTenant = typeof sp.tenant === "string" ? sp.tenant : "";
  const tenantParam = rawTenant === "none" || SLUG_REGEX.test(rawTenant) ? rawTenant : "";
  const chainParam = typeof sp.chain === "string" && UUID_REGEX.test(sp.chain) ? sp.chain : null;

  const env = getWebEnv();
  const instance = env.INFRA_JOBS_INSTANCE;
  const featureOn = instance !== undefined && userFeatureEnabled(instanceJobTypes(env.INFRA_JOBS_TYPES));
  const canManage = featureOn && can(session.roles, "users:manage");

  const tenants = await listTenants();
  const selected = tenantParam && tenantParam !== "none" ? (tenants.find((t) => t.slug === tenantParam) ?? null) : null;
  const filterId = tenantParam === "none" ? "none" : (selected?.id ?? null);
  const [rows, chains] = await Promise.all([listUsers(filterId), listRecentChains(selected?.id ?? null)]);
  const clientIds = [...new Set([...rows.map((u) => u.clientId), selected?.id].filter((x): x is string => typeof x === "string"))];
  const allEnvs = (await listEnvsByClient(clientIds)).filter((e) => instance !== undefined && envAllowedForInstance(instance, e.kind));
  const access = await listAccessByEnvs(allEnvs.map((e) => e.environmentId));
  const envsOf = (clientId: string | null) => allEnvs.filter((e) => e.clientId === clientId);
  const tenantOf = (clientId: string | null) => tenants.find((t) => t.id === clientId) ?? null;
  const backValue = tenantParam || "";

  return (
    <>
      <Nav session={session} />
      <main className="space-y-6 p-6">
        <h1 className="text-lg font-semibold">Users</h1>
        {r ? <ResultBanner code={r} text={ACTION_RESULT_TEXT[r]} jobId={null} /> : null}
        {chainParam ? (
          <p className="text-xs text-slate-500">
            Rantai <span className="font-mono">{chainParam}</span> — status per langkah di bawah.
          </p>
        ) : null}
        {!featureOn ? (
          <p role="status" className="rounded bg-amber-50 p-3 text-sm text-amber-800">
            Aksi user nonaktif di instance ini ({instance ?? "INFRA_JOBS_INSTANCE kosong"}): tipe job identitas belum ada di
            allowlist <span className="font-mono">INFRA_JOBS_TYPES</span> (cermin <span className="font-mono">job_types</span>{" "}
            dispatcher). Daftar tetap bisa dilihat.
          </p>
        ) : null}
        {!tenants.some((t) => t.isPlatform) ? (
          <p role="status" className="rounded bg-amber-50 p-3 text-sm text-amber-800">
            Tenant internal <span className="font-mono">platform</span> belum ada — jalankan migrasi (langkah boot membuatnya).
          </p>
        ) : null}

        <form method="get" className="flex flex-wrap items-center gap-2 text-sm">
          <label>
            Tenant{" "}
            <select name="tenant" defaultValue={tenantParam} className={input}>
              <option value="">semua</option>
              {tenants.map((t) => (
                <option key={t.id} value={t.slug}>
                  {t.slug}
                  {t.isPlatform ? " (internal)" : ""}
                  {t.terminatedAt ? " — terminated" : ""}
                </option>
              ))}
              <option value="none">(tanpa tenant)</option>
            </select>
          </label>
          <button type="submit" className={btn}>
            Filter
          </button>
        </form>

        <table className="w-full border bg-white text-left text-sm">
          <thead className="bg-slate-100">
            <tr>
              <th className="p-2">Email</th>
              <th className="p-2">Nama</th>
              <th className="p-2">Tenant</th>
              <th className="p-2">Role CP</th>
              <th className="p-2">Status</th>
              <th className="p-2">Login terakhir (UTC)</th>
              <th className="p-2">Aksi</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={7} className="p-2 text-slate-500">
                  Belum ada user.
                </td>
              </tr>
            ) : (
              rows.map((u) => {
                const t = tenantOf(u.clientId);
                const roles = t ? cpRolesForSlug(t.isPlatform ? "platform" : t.slug) : [];
                return (
                  <tr key={u.id} className="border-t align-top">
                    <td className="p-2 font-mono">{u.email ?? "—"}</td>
                    <td className="p-2">{u.displayName ?? "—"}</td>
                    <td className="p-2 font-mono">{u.slug ?? "(tanpa tenant)"}</td>
                    <td className="p-2">{roleLabel(u.role)}</td>
                    <td className="p-2">
                      <StatusBadge value={u.status} />
                    </td>
                    <td className="p-2 whitespace-nowrap">{fmt(u.lastLoginAt)}</td>
                    <td className="space-y-2 p-2">
                      {canManage && u.clientId === null && u.email && u.status !== "disabled" ? (
                        <AdoptForm user={u} tenants={tenants} back={backValue} />
                      ) : null}
                      {canManage && t && u.email ? (
                        <>
                          <div className="flex flex-wrap gap-1">
                            {u.status !== "disabled" ? (
                              <>
                                <form action={passwordResetAction}>
                                  <input type="hidden" name="back" value={backValue} />
                                  <input type="hidden" name="userId" value={u.id} />
                                  <button type="submit" className={btn}>
                                    Kirim reset password
                                  </button>
                                </form>
                                <form action={disableUserAction} className="flex items-center gap-1">
                                  <input type="hidden" name="back" value={backValue} />
                                  <input type="hidden" name="userId" value={u.id} />
                                  <label className="text-xs">
                                    <input type="checkbox" name="confirm" required /> yakin
                                  </label>
                                  <button type="submit" className={btnDanger}>
                                    Nonaktifkan
                                  </button>
                                </form>
                              </>
                            ) : null}
                          </div>
                          {u.status === "disabled" ? (
                            <form action={enableUserAction} className="flex flex-wrap items-center gap-2">
                              <input type="hidden" name="back" value={backValue} />
                              <input type="hidden" name="userId" value={u.id} />
                              <OdooSelects envs={t.isPlatform ? [] : envsOf(u.clientId)} access={access} email={u.email} />
                              <button type="submit" className={btn}>
                                Aktifkan
                              </button>
                            </form>
                          ) : (
                            <details>
                              <summary className="cursor-pointer text-xs underline">Ubah role / akses Odoo</summary>
                              <form action={changeUserAccessAction} className="mt-2 flex flex-wrap items-center gap-2">
                                <input type="hidden" name="back" value={backValue} />
                                <input type="hidden" name="userId" value={u.id} />
                                <select name="cp_role" defaultValue={u.role} className={input}>
                                  {roles.map((rr) => (
                                    <option key={rr} value={rr}>
                                      {roleLabel(rr)}
                                    </option>
                                  ))}
                                </select>
                                <OdooSelects envs={t.isPlatform ? [] : envsOf(u.clientId)} access={access} email={u.email} />
                                <button type="submit" className={btn}>
                                  Simpan
                                </button>
                              </form>
                            </details>
                          )}
                        </>
                      ) : null}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>

        {canManage ? (
          selected && !selected.terminatedAt ? (
            <form action={addUserAction} className="flex flex-wrap items-center gap-2 rounded border bg-white p-4 text-sm">
              <span className="font-semibold">
                Tambah user ke <span className="font-mono">{selected.slug}</span>
              </span>
              <input type="hidden" name="back" value={backValue} />
              <input type="hidden" name="clientId" value={selected.id} />
              <input name="email" type="email" required maxLength={254} placeholder="email" className={input} />
              <input name="name" maxLength={100} placeholder="nama (ASCII, opsional)" className={input} />
              <select name="cp_role" defaultValue={selected.isPlatform ? "ops" : "client_user"} className={input}>
                {cpRolesForSlug(selected.isPlatform ? "platform" : selected.slug).map((rr) => (
                  <option key={rr} value={rr}>
                    {roleLabel(rr)}
                  </option>
                ))}
              </select>
              {selected.isPlatform ? null : <OdooSelects envs={envsOf(selected.id)} access={[]} email={null} />}
              <button type="submit" className={btn}>
                Undang
              </button>
              <p className="w-full text-xs text-slate-500">
                Rantai job: kc_user_ensure (undangan email) → kc_user_set_roles → odoo_user_ensure per environment dengan akses ≠ none.
                Baris user tercatat setelah kc_user_ensure sukses (id Keycloak = sub).
              </p>
            </form>
          ) : (
            <p className="text-sm text-slate-500">Pilih satu tenant (filter) untuk menambah user.</p>
          )
        ) : null}

        <section className="space-y-2">
          <h2 className="font-semibold">Rantai job terbaru</h2>
          {chains.length === 0 ? (
            <p className="text-sm text-slate-500">Belum ada.</p>
          ) : (
            <ul className="space-y-2">
              {chains.map((c) => (
                <li
                  key={c.chainId}
                  className={`rounded border bg-white p-3 text-sm ${c.chainId === chainParam ? "border-blue-400" : ""}`}
                >
                  <div className="text-xs text-slate-500">
                    {fmt(c.createdAt)} · <span className="font-mono">{c.steps[0]?.slug ?? "—"}</span> ·{" "}
                    <span className="font-mono">{c.steps.find((s) => s.email)?.email ?? "—"}</span> · {c.actor}
                  </div>
                  <ol className="mt-1 flex flex-wrap items-center gap-1">
                    {c.steps.map((s, i) => (
                      <li key={s.id} className="flex items-center gap-1">
                        {i > 0 ? <span aria-hidden="true">→</span> : null}
                        <Link href={`/jobs/${s.id}`} className="font-mono underline">
                          {s.type}@{s.env ?? "?"}
                        </Link>
                        <StatusBadge value={s.status} />
                        {s.errorCode ? <span className="font-mono text-xs text-red-700">{s.errorCode}</span> : null}
                      </li>
                    ))}
                  </ol>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </>
  );
}
