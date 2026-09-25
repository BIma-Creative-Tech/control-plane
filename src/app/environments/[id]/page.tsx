import Link from "next/link";
import { notFound } from "next/navigation";
import { getWebEnv } from "@/env";
import { requirePermission } from "@/lib/authz";
import { UUID_REGEX, defaultHost, envAllowedForInstance } from "@/lib/job-contract";
import { ssoUserRowActions } from "@/lib/job-forms";
import { ACTION_RESULT_TEXT, parseActionResult } from "@/lib/job-list-params";
import { can } from "@/lib/roles";
import { countActiveJobs, getEnvironment, listAuditForEnvironment, listJobs, listTenantUsers } from "@/server/queries";
import { JobTable, ResultBanner, StatusBadge } from "../../jobs/components";
import { Nav } from "../../nav";
import {
  provisionDbAction,
  removeRouteAction,
  renderRouteAction,
  ssoDisableAction,
  ssoProvisionAction,
  ssoRotateAction,
  ssoUserAction,
} from "./actions";

const btn = "rounded border px-3 py-1 text-sm hover:bg-slate-100 disabled:opacity-50";
const btnDanger = "rounded border border-red-300 px-3 py-1 text-sm text-red-700 hover:bg-red-50";
const input = "rounded border px-2 py-1 text-sm";

export default async function EnvironmentPage(props: PageProps<"/environments/[id]">) {
  const session = await requirePermission("jobs:view");
  const { id } = await props.params;
  if (!UUID_REGEX.test(id)) notFound();
  const env = await getEnvironment(id);
  if (!env) notFound();
  const sp = await props.searchParams;
  const r = parseActionResult(sp.r);
  const jobParam = typeof sp.job === "string" && UUID_REGEX.test(sp.job) ? sp.job : null;

  const instance = getWebEnv().INFRA_JOBS_INSTANCE;
  const bridgeOn = instance !== undefined && envAllowedForInstance(instance, env.kind);
  const canOdoo = bridgeOn && can(session.roles, "jobs:odoo");
  const canAdmin = bridgeOn && can(session.roles, "jobs:odoo_admin");

  const [tenantUsers, jobs, audit, active] = await Promise.all([
    listTenantUsers(env.id),
    listJobs({ environmentId: env.id, page: 1 }, 20),
    listAuditForEnvironment(env.id),
    countActiveJobs(env.id),
  ]);
  const urlHost = (() => {
    try {
      return new URL(env.url).hostname;
    } catch {
      return "";
    }
  })();
  const suggestedHost = env.host ?? (urlHost || defaultHost(env.slug, env.kind) || "");
  const busy = (t: string) => active.has(t as never);

  return (
    <>
      <Nav session={session} />
      <main className="space-y-6 p-6">
        <div>
          <p className="text-xs text-slate-500">
            <Link href="/clients" className="underline">
              Clients
            </Link>{" "}
            /{" "}
            <Link href={`/clients/${env.slug}`} className="underline">
              {env.slug}
            </Link>
          </p>
          <h1 className="text-lg font-semibold">
            Environment <span className="font-mono">{env.kind}</span> — {env.clientName}
          </h1>
        </div>

        {r ? <ResultBanner code={r} text={ACTION_RESULT_TEXT[r]} jobId={jobParam} /> : null}
        {!bridgeOn ? (
          <p role="status" className="rounded bg-amber-50 p-3 text-sm text-amber-800">
            Aksi job nonaktif: instance ini ({instance ?? "tidak dikonfigurasi"}) tidak melayani env{" "}
            <span className="font-mono">{env.kind}</span>.
          </p>
        ) : null}

        <section className="grid gap-2 rounded border bg-white p-4 text-sm sm:grid-cols-2">
          <div>
            DB: <span className="font-mono">{env.dbName}</span> <StatusBadge value={env.dbStatus} />
          </div>
          <div>
            Route: <span className="font-mono">{env.host ?? "—"}</span> <StatusBadge value={env.routeStatus} />
          </div>
          <div>
            SSO: <span className="font-mono">{env.ssoClientId ?? "—"}</span> <StatusBadge value={env.ssoStatus} />
            {env.ssoProviderId !== null ? <span className="ml-2 text-slate-500">provider #{env.ssoProviderId}</span> : null}
          </div>
          <div>
            Instance Odoo: <span className="font-mono">{env.odooInstance}</span> · URL: <span className="font-mono">{env.url}</span>
          </div>
        </section>

        {canOdoo ? (
          <section className="space-y-4 rounded border bg-white p-4">
            <h2 className="font-semibold">Aksi</h2>

            <form action={provisionDbAction} className="flex flex-wrap items-center gap-2">
              <input type="hidden" name="environmentId" value={env.id} />
              <label className="text-sm">
                Host (wajib untuk demo){" "}
                <input name="host" defaultValue={suggestedHost} maxLength={253} className={input} />
              </label>
              <button type="submit" className={btn} disabled={busy("odoo_db_provision")}>
                1. Provision DB
              </button>
            </form>

            <form action={renderRouteAction} className="flex flex-wrap items-center gap-2">
              <input type="hidden" name="environmentId" value={env.id} />
              <label className="text-sm">
                Host <input name="host" defaultValue={suggestedHost} maxLength={253} className={input} />
              </label>
              <button type="submit" className={btn} disabled={busy("odoo_route")}>
                2. Render route
              </button>
            </form>

            <form action={ssoProvisionAction} className="flex flex-wrap items-center gap-3">
              <input type="hidden" name="environmentId" value={env.id} />
              <span className="text-sm text-slate-600">Host SSO = host route aktif ({env.host ?? "belum ada"})</span>
              <label className="text-sm">
                <input type="checkbox" name="dry_run" /> dry-run saja
              </label>
              <label className="text-sm">
                <input type="checkbox" name="skip_smoke" /> skip smoke (host default, sebelum route)
              </label>
              <button type="submit" className={btn} disabled={busy("odoo_sso_provision")}>
                3. Aktifkan SSO
              </button>
            </form>

            {canAdmin ? (
              <div className="space-y-3 border-t pt-3">
                <p className="text-xs text-slate-500">Aksi superadmin — ketik slug untuk konfirmasi.</p>
                <form action={ssoRotateAction} className="flex flex-wrap items-center gap-2">
                  <input type="hidden" name="environmentId" value={env.id} />
                  <input name="confirm" placeholder={env.slug} required maxLength={30} className={input} />
                  <label className="text-sm">
                    <input type="checkbox" name="dry_run" /> dry-run
                  </label>
                  <button type="submit" className={btnDanger} disabled={busy("odoo_sso_provision")}>
                    Rotasi secret SSO
                  </button>
                </form>
                <form action={ssoDisableAction} className="flex flex-wrap items-center gap-2">
                  <input type="hidden" name="environmentId" value={env.id} />
                  <input name="confirm" placeholder={env.slug} required maxLength={30} className={input} />
                  <label className="text-sm">
                    <input type="checkbox" name="dry_run" /> dry-run
                  </label>
                  <button type="submit" className={btnDanger} disabled={busy("odoo_sso_disable")}>
                    Nonaktifkan SSO
                  </button>
                </form>
                <form action={removeRouteAction} className="flex flex-wrap items-center gap-2">
                  <input type="hidden" name="environmentId" value={env.id} />
                  <input name="confirm" placeholder={env.slug} required maxLength={30} className={input} />
                  <button type="submit" className={btnDanger} disabled={busy("odoo_route")}>
                    Hapus route
                  </button>
                </form>
              </div>
            ) : null}
          </section>
        ) : null}

        <section className="space-y-3 rounded border bg-white p-4">
          <h2 className="font-semibold">Pengguna SSO</h2>
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-100">
              <tr>
                <th className="p-2">Email</th>
                <th className="p-2">Login Odoo</th>
                <th className="p-2">Admin</th>
                <th className="p-2">Status</th>
                <th className="p-2">KC / Odoo id</th>
                <th className="p-2">Aksi</th>
              </tr>
            </thead>
            <tbody>
              {tenantUsers.length === 0 ? (
                <tr>
                  <td colSpan={6} className="p-2 text-slate-500">
                    Belum ada.
                  </td>
                </tr>
              ) : (
                tenantUsers.map((u) => (
                  <tr key={u.id} className="border-t">
                    <td className="p-2 font-mono">{u.email}</td>
                    <td className="p-2 font-mono">{u.odooLogin ?? "(email)"}</td>
                    <td className="p-2">{u.isTenantAdmin ? "ya" : "—"}</td>
                    <td className="p-2">
                      <StatusBadge value={u.status} />
                    </td>
                    <td className="p-2 font-mono text-xs">
                      {u.kcUserId ?? "—"} / {u.odooUserId ?? "—"}
                    </td>
                    <td className="p-2">
                      {canOdoo ? (
                        <div className="flex gap-1">
                          {ssoUserRowActions(u.status).map((a) => (
                            <form key={a} action={ssoUserAction}>
                              <input type="hidden" name="environmentId" value={env.id} />
                              <input type="hidden" name="action" value={a} />
                              <input type="hidden" name="email" value={u.email} />
                              {u.odooLogin ? <input type="hidden" name="login" value={u.odooLogin} /> : null}
                              {/* dispatcher menolak revoke dengan admin/create_kc */}
                              {a === "resend_invite" && u.isTenantAdmin ? <input type="hidden" name="admin" value="on" /> : null}
                              <button type="submit" className={a === "revoke" ? btnDanger : btn} disabled={busy("odoo_sso_user")}>
                                {a === "revoke" ? "Cabut" : "Kirim ulang"}
                              </button>
                            </form>
                          ))}
                        </div>
                      ) : null}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
          {canOdoo ? (
            <form action={ssoUserAction} className="flex flex-wrap items-center gap-2 border-t pt-3">
              <input type="hidden" name="environmentId" value={env.id} />
              <input type="hidden" name="action" value="grant" />
              <input name="email" type="email" required maxLength={254} placeholder="email" className={input} />
              <input name="login" maxLength={254} placeholder="login Odoo (opsional)" className={input} />
              <label className="text-sm">
                <input type="checkbox" name="admin" /> admin tenant (TOTP)
              </label>
              <label className="text-sm">
                <input type="checkbox" name="create_kc" defaultChecked /> buat user Keycloak + undangan
              </label>
              <label className="text-sm">
                <input type="checkbox" name="dry_run" /> dry-run
              </label>
              <button type="submit" className={btn} disabled={busy("odoo_sso_user")}>
                Undang
              </button>
              <p className="w-full text-xs text-slate-500">
                res.users dengan login tersebut harus sudah dibuat manual di Odoo; bila belum, job gagal
                (blocked_dry_run) tanpa membuat user Keycloak.
              </p>
            </form>
          ) : null}
        </section>

        <section className="space-y-2">
          <h2 className="font-semibold">Job terbaru</h2>
          <JobTable rows={jobs} />
          <Link href={`/jobs?client=${env.slug}`} className="text-sm underline">
            Semua job client ini
          </Link>
        </section>

        <section className="space-y-2">
          <h2 className="font-semibold">Audit</h2>
          <table className="w-full border bg-white text-left text-xs">
            <thead className="bg-slate-100">
              <tr>
                <th className="p-2">Waktu</th>
                <th className="p-2">Aktor</th>
                <th className="p-2">Aksi</th>
                <th className="p-2">Hasil</th>
                <th className="p-2">Metadata</th>
              </tr>
            </thead>
            <tbody>
              {audit.map((a) => (
                <tr key={String(a.id)} className="border-t align-top">
                  <td className="p-2 whitespace-nowrap">{a.occurredAt.toISOString().replace("T", " ").slice(0, 19)}</td>
                  <td className="p-2 font-mono">{a.actorEmail ?? a.actor}</td>
                  <td className="p-2 font-mono">{a.action}</td>
                  <td className="p-2">{a.result}</td>
                  <td className="p-2 font-mono break-all">{JSON.stringify(a.metadata)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </main>
    </>
  );
}
