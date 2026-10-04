import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/db";
import { getTenantBySlug, listClientChains, listTenantDomains, listUsersOfTenant } from "@/db/tenant-queries";
import { getWebEnv } from "@/env";
import { requirePermission } from "@/lib/authz";
import { INSTANCE_ENVS, UUID_REGEX, envAllowedForInstance, instanceJobTypes, routeManagedManually } from "@/lib/job-contract";
import { ACTION_RESULT_TEXT, parseActionResult } from "@/lib/job-list-params";
import { ROLE_LABELS, can } from "@/lib/roles";
import { isValidSlug } from "@/lib/slug";
import { TENANT_STATE_TYPES, TENANT_SYNC_TYPES, typesEnabled } from "@/lib/tenant-onboarding";
import { MANUAL_ROUTE_NOTE } from "@/lib/tenant-register";
import { listEnvironmentsForClient, listJobs } from "@/server/queries";
import { JobTable, ResultBanner, StatusBadge } from "../../jobs/components";
import { Nav } from "../../nav";
import { SubmitButton } from "@/components/submit-button";
import { createEnvironmentAction, syncTenantAction, tenantStateAction } from "../actions";
import { createDomainAction, deleteDomainAction, updateDomainAction } from "../domain-actions";
import { DnsChecklistTable } from "../../domains/checklist";
import { DOMAIN_PURPOSES, ENV_LINK_PURPOSES } from "@/lib/domains";
import { ChainList } from "../chain-list";
import { TenantBillingSummary } from "../../billing/tenant-billing";

const input = "rounded border px-2 py-1 text-sm";
const btnDanger = "rounded border border-red-300 px-3 py-1 text-sm text-red-700 hover:bg-red-50";
const btn = "rounded border px-3 py-1 text-sm hover:bg-slate-100";

/**
 * Detail tenant (W5): status, environment (db/route/sso/tenant_check), user tenant, rantai & job terakhir, Suspend/
 * Resume override (superadmin, ketik slug), ringkasan langganan & invoice. Lihat: superadmin+ops (`jobs:view`);
 * mutasi: superadmin.
 */
export default async function ClientPage(props: PageProps<"/clients/[slug]">) {
  const session = await requirePermission("jobs:view");
  const { slug } = await props.params;
  if (!isValidSlug(slug)) notFound();
  const db = getDb();
  const client = await getTenantBySlug(db, slug);
  if (!client) notFound();
  const sp = await props.searchParams;
  const r = parseActionResult(sp.r);
  const chainParam = typeof sp.chain === "string" && UUID_REGEX.test(sp.chain) ? sp.chain : null;
  const env = getWebEnv();
  const instance = env.INFRA_JOBS_INSTANCE;
  const kinds = instance ? INSTANCE_ENVS[instance] : (["prod", "demo", "staging"] as const);
  const canManage = can(session.roles, "clients:manage");

  const [envs, tenantUsers, jobs, chains, domainRows] = await Promise.all([
    listEnvironmentsForClient(client.id),
    listUsersOfTenant(db, client.id),
    listJobs({ client: client.slug, page: 1 }, 10),
    listClientChains(db, client.id, 10),
    listTenantDomains(db, client.id),
  ]);
  const canDomains = can(session.roles, "domains:manage") && !client.isPlatform && !client.terminatedAt && client.status !== "terminated";
  const platformIpv4 = env.PLATFORM_PUBLIC_IPV4 ?? null;
  const instanceEnvs = instance ? envs.filter((e) => envAllowedForInstance(instance, e.kind)) : [];
  const stateOn =
    canManage &&
    instance !== undefined &&
    !client.isPlatform &&
    !client.terminatedAt &&
    instanceEnvs.length > 0 &&
    typesEnabled(instanceJobTypes(env.INFRA_JOBS_TYPES), TENANT_STATE_TYPES);
  const syncOn =
    canManage &&
    instance !== undefined &&
    !client.isPlatform &&
    !client.terminatedAt &&
    instanceEnvs.length > 0 &&
    typesEnabled(instanceJobTypes(env.INFRA_JOBS_TYPES), TENANT_SYNC_TYPES);
  const currentCheck = instanceEnvs.find((e) => e.ssoStatus === "active" && e.tenantCheck)?.tenantCheck ?? "compat";

  return (
    <>
      <Nav session={session} />
      <main className="space-y-6 p-6">
        <p className="text-xs text-slate-500">
          <Link href="/clients" className="underline">
            Clients
          </Link>
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-lg font-semibold">
            {client.name} <span className="font-mono text-slate-500">({client.slug})</span>
          </h1>
          <StatusBadge value={client.status} />
          {client.isPlatform ? <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs">tenant internal</span> : null}
        </div>
        {r ? <ResultBanner code={r} text={ACTION_RESULT_TEXT[r]} jobId={null} /> : null}

        <section className="grid gap-2 rounded border bg-white p-4 text-sm sm:grid-cols-2">
          <div>
            Brand: <span>{client.brand ?? "—"}</span>
          </div>
          <div>
            Isolasi: <span className="font-mono">{client.isolation}</span>
          </div>
          <div>
            Organization Keycloak: <span className="font-mono">{client.kcOrgId ?? "— (belum dibuat)"}</span>
          </div>
          <div>
            Dibuat: <span>{client.createdAt.toISOString().slice(0, 10)}</span>
            {client.terminatedAt ? <span className="ml-2 text-red-700">terminated {client.terminatedAt.toISOString().slice(0, 10)}</span> : null}
          </div>
        </section>

        <section className="space-y-2">
          <h2 className="font-semibold">Environment</h2>
          <table className="w-full border bg-white text-left text-sm">
            <thead className="bg-slate-100">
              <tr>
                <th className="p-2">Env</th>
                <th className="p-2">DB</th>
                <th className="p-2">Host</th>
                <th className="p-2">Route</th>
                <th className="p-2">SSO</th>
                <th className="p-2">tenant_check</th>
              </tr>
            </thead>
            <tbody>
              {envs.length === 0 ? (
                <tr>
                  <td colSpan={6} className="p-2 text-slate-500">
                    Belum ada environment.
                  </td>
                </tr>
              ) : (
                envs.map((e) => {
                  return (
                    <tr key={e.id} className="border-t">
                      <td className="p-2 font-mono">
                        <Link href={`/environments/${e.id}`} className="underline">
                          {e.kind}
                        </Link>
                      </td>
                      <td className="p-2 font-mono">
                        {e.dbName} <StatusBadge value={e.dbStatus} />
                      </td>
                      <td className="p-2 font-mono">
                        {e.host ?? "—"}
                        {routeManagedManually(e) ? (
                          <span className="ml-2 rounded bg-amber-50 px-1.5 py-0.5 font-sans text-xs text-amber-800">{MANUAL_ROUTE_NOTE}</span>
                        ) : null}
                      </td>
                      <td className="p-2">
                        <StatusBadge value={e.routeStatus} />
                      </td>
                      <td className="p-2">
                        <StatusBadge value={e.ssoStatus} />
                      </td>
                      {/* Migrasi 0005: environments.tenant_check dari RESULT `mode` odoo_tenant_config (rekonsiliasi worker). */}
                      <td className="p-2 font-mono">{e.tenantCheck ?? "—"}</td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
          {canManage && !client.isPlatform ? (
            <form action={createEnvironmentAction} className="flex flex-wrap items-center gap-2 rounded border bg-white p-4 text-sm">
              <input type="hidden" name="clientId" value={client.id} />
              <span className="font-semibold">Tambah environment</span>
              <select name="kind" className={input}>
                {kinds.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
              <input name="host" maxLength={253} placeholder="host (wajib untuk demo)" className={input} />
              <button type="submit" className={btn}>
                Simpan
              </button>
            </form>
          ) : null}
        </section>

        {syncOn ? (
          <section className="space-y-2 rounded border bg-white p-4 text-sm">
            <h2 className="font-semibold">Sinkronkan tenant</h2>
            <p className="text-xs text-slate-500">
              Rantai <span className="font-mono">kc_org_ensure</span> → <span className="font-mono">odoo_tenant_config</span> untuk env
              ber-SSO aktif ({instanceEnvs.filter((e) => e.ssoStatus === "active").map((e) => e.kind).join(", ") || "tidak ada"}):
              membuat organization Keycloak bila belum ada dan menulis mode <span className="font-mono">tenant_check</span> (+ tenant
              platform agar staf tetap bisa masuk). <span className="font-mono">strict</span> ditolak skrip bila modul Odoo &lt; 19.0.1.4.0;
              aktifkan hanya setelah observasi <span className="font-mono">compat</span> bersih.
            </p>
            <form action={syncTenantAction} className="flex flex-wrap items-center gap-2">
              <input type="hidden" name="clientId" value={client.id} />
              <label>
                tenant_check{" "}
                <select name="tenant_check" defaultValue={currentCheck} className={input}>
                  <option value="off">off</option>
                  <option value="compat">compat</option>
                  <option value="strict">strict</option>
                </select>
              </label>
              <SubmitButton className={btn}>Sinkronkan</SubmitButton>
            </form>
          </section>
        ) : null}

        {stateOn ? (
          <section className="space-y-2 rounded border border-red-200 bg-white p-4 text-sm">
            <h2 className="font-semibold">Suspend / Resume (override manual)</h2>
            <p className="text-xs text-slate-500">
              Job <span className="font-mono">tenant_suspend</span>/<span className="font-mono">tenant_resume</span> untuk env{" "}
              {instanceEnvs.map((e) => e.kind).join(", ")}: route Odoo dialihkan ke halaman ditangguhkan (DB/filestore utuh, user
              Keycloak tidak dinonaktifkan). Ketik slug <span className="font-mono">{client.slug}</span> untuk konfirmasi.
            </p>
            {(["suspend", "resume"] as const).map((a) => (
              <form key={a} action={tenantStateAction} className="flex flex-wrap items-center gap-2">
                <input type="hidden" name="clientId" value={client.id} />
                <input type="hidden" name="action" value={a} />
                <input name="confirm" required maxLength={64} placeholder={`ketik ${client.slug}`} autoComplete="off" className={input} />
                <button type="submit" className={a === "suspend" ? btnDanger : btn}>
                  {a === "suspend" ? "Suspend" : "Resume"}
                </button>
              </form>
            ))}
          </section>
        ) : null}

        {/* Ringkasan langganan & invoice (ADR 0018) — aksi di /subscriptions dan /invoices. */}
        {!client.isPlatform ? <TenantBillingSummary session={session} clientId={client.id} slug={client.slug} /> : null}

        {!client.isPlatform ? (
          <section id="domains" className="space-y-2">
            <div className="flex flex-wrap items-center gap-3">
              <h2 className="font-semibold">Domain</h2>
              <span className="text-xs text-slate-500">
                Checklist DNS digenerate; verifikasi otomatis: Fase 2. IP platform: {platformIpv4 ?? "IP belum dikonfigurasi"}.
              </span>
            </div>
            {domainRows.length === 0 ? <p className="text-sm text-slate-500">Belum ada domain.</p> : null}
            {domainRows.map((d) => (
              <div key={d.id} className="space-y-2 rounded border bg-white p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono font-semibold">{d.fqdn}</span>
                  <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs">{d.purpose ?? "purpose ?"}</span>
                  {d.envKind ? <span className="font-mono text-xs text-slate-500">env {d.envKind}</span> : null}
                  <StatusBadge value={d.status} />
                </div>
                <DnsChecklistTable fqdn={d.fqdn} purpose={d.purpose} dkimTxt={d.dkimTxt} platformIpv4={platformIpv4} />
                {canDomains ? (
                  <div className="flex flex-wrap gap-4">
                    <details>
                      <summary className="cursor-pointer text-xs underline">Ubah…</summary>
                      <form action={updateDomainAction} className="mt-2 flex flex-wrap items-center gap-2">
                        <input type="hidden" name="back" value={client.slug} />
                        <input type="hidden" name="domainId" value={d.id} />
                        <select name="purpose" defaultValue={d.purpose ?? "odoo"} className={input}>
                          {DOMAIN_PURPOSES.map((p) => (
                            <option key={p} value={p}>
                              {p}
                            </option>
                          ))}
                        </select>
                        <select name="environmentId" defaultValue={d.environmentId ?? ""} className={input}>
                          <option value="">tanpa environment</option>
                          {envs.map((e) => (
                            <option key={e.id} value={e.id}>
                              {e.kind}
                            </option>
                          ))}
                        </select>
                        <input name="dkim_txt" defaultValue={d.dkimTxt ?? ""} maxLength={2048} placeholder="DKIM TXT (mail)" className={`${input} w-80`} />
                        <button type="submit" className={btn}>
                          Simpan
                        </button>
                      </form>
                    </details>
                    <details>
                      <summary className="cursor-pointer text-xs text-red-700 underline">Hapus…</summary>
                      <form action={deleteDomainAction} className="mt-2 flex flex-wrap items-center gap-2">
                        <input type="hidden" name="back" value={client.slug} />
                        <input type="hidden" name="domainId" value={d.id} />
                        <input name="confirm" required maxLength={253} placeholder={`ketik ${d.fqdn}`} autoComplete="off" className={input} />
                        <button type="submit" className={btnDanger}>
                          Hapus
                        </button>
                      </form>
                    </details>
                  </div>
                ) : null}
              </div>
            ))}
            {canDomains ? (
              <form action={createDomainAction} className="flex flex-wrap items-center gap-2 rounded border bg-white p-4 text-sm">
                <span className="font-semibold">Tambah domain</span>
                <input type="hidden" name="back" value={client.slug} />
                <input type="hidden" name="clientId" value={client.id} />
                <input name="fqdn" required maxLength={253} placeholder="erp.klien.co.id" className={input} />
                <select name="purpose" defaultValue="odoo" className={input}>
                  {DOMAIN_PURPOSES.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
                <select name="environmentId" defaultValue="" className={input}>
                  <option value="">tanpa environment</option>
                  {envs.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.kind}
                    </option>
                  ))}
                </select>
                <input name="dkim_txt" maxLength={2048} placeholder="DKIM TXT (mail, opsional)" className={`${input} w-80`} />
                <button type="submit" className={btn}>
                  Simpan
                </button>
                <p className="w-full text-xs text-slate-500">
                  Status awal pending_dns. Environment hanya untuk kegunaan {ENV_LINK_PURPOSES.join("/")}; DKIM hanya untuk mail.
                </p>
              </form>
            ) : null}
          </section>
        ) : null}

        <section className="space-y-2">
          <div className="flex items-center gap-3">
            <h2 className="font-semibold">User tenant</h2>
            <Link href={`/users?tenant=${client.slug}`} className="text-sm underline">
              Kelola di halaman Users
            </Link>
          </div>
          <table className="w-full border bg-white text-left text-sm">
            <thead className="bg-slate-100">
              <tr>
                <th className="p-2">Email</th>
                <th className="p-2">Nama</th>
                <th className="p-2">Role</th>
                <th className="p-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {tenantUsers.length === 0 ? (
                <tr>
                  <td colSpan={4} className="p-2 text-slate-500">
                    Belum ada user (baris tercatat setelah job kc_user_ensure sukses).
                  </td>
                </tr>
              ) : (
                tenantUsers.map((u) => (
                  <tr key={u.id} className="border-t">
                    <td className="p-2 font-mono">{u.email ?? "—"}</td>
                    <td className="p-2">{u.displayName ?? "—"}</td>
                    <td className="p-2">{ROLE_LABELS[u.role]}</td>
                    <td className="p-2">
                      <StatusBadge value={u.status} />
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </section>

        <section className="space-y-2">
          <h2 className="font-semibold">Rantai job terakhir</h2>
          <ChainList chains={chains} canRetry={canManage && instance !== undefined} highlight={chainParam} />
        </section>

        <section className="space-y-2">
          <div className="flex items-center gap-3">
            <h2 className="font-semibold">10 job terakhir</h2>
            <Link href={`/jobs?client=${client.slug}`} className="text-sm underline">
              Semua job
            </Link>
          </div>
          <JobTable rows={jobs} />
        </section>
      </main>
    </>
  );
}
