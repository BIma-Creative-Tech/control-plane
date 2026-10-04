import Link from "next/link";
import { getWebEnv } from "@/env";
import { requirePermission } from "@/lib/authz";
import { parseClientListParams } from "@/lib/client-list-params";
import { INSTANCE_ENVS, dbNameFor, instanceJobTypes, type BridgeJobType, type Instance } from "@/lib/job-contract";
import { ACTION_RESULT_TEXT, parseActionResult } from "@/lib/job-list-params";
import { can } from "@/lib/roles";
import { ONBOARDING_TYPES, typesEnabled } from "@/lib/tenant-onboarding";
import { MANUAL_ROUTE_NOTE, REGISTER_EXISTING_TYPES } from "@/lib/tenant-register";
import { listPlans } from "@/server/billing-queries";
import { ResultBanner, StatusBadge } from "../jobs/components";
import { Nav } from "../nav";
import { SubmitButton } from "@/components/submit-button";

import { createClientAction, onboardTenantAction, registerExistingTenantAction } from "./actions";
import { PAGE_SIZE, listClients } from "./query";

const input = "rounded border px-2 py-1";

/**
 * "Tenant baru" (SaaS Fase 1 W5) — satu form: data tenant + admin + environment instance ini. Server mengulang semua
 * validasi (parseOnboardingForm + layanan onboardTenant); field yang tidak relevan untuk instance ditolak.
 */
function OnboardingForm({ instance, plans }: { instance: Instance; plans: { id: string; code: string; name: string }[] }) {
  return (
    <form action={onboardTenantAction} className="mt-4 space-y-3 rounded border bg-white p-4 text-sm">
      <h2 className="font-semibold">Tenant baru</h2>
      <div className="flex flex-wrap gap-2">
        <input name="slug" required maxLength={30} pattern="[a-z0-9-]{3,30}" placeholder="slug (bukan platform)" className={input} />
        <input name="name" required maxLength={200} placeholder="nama tenant" className={input} />
        <input name="brand" maxLength={100} placeholder="brand (opsional)" className={input} />
      </div>
      <div className="flex flex-wrap gap-2">
        <input name="admin_email" type="email" required maxLength={254} placeholder="email tenant-admin" className={input} />
        <input name="admin_name" required maxLength={100} placeholder="nama admin (ASCII)" className={input} />
      </div>
      {plans.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          <label>
            Plan Odoo{" "}
            <select name="plan_id" defaultValue="" className={input}>
              <option value="">— tanpa langganan (atur nanti di Subscriptions) —</option>
              {plans.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.code} — {p.name}
                </option>
              ))}
            </select>
          </label>
          <span className="text-xs text-slate-500">Bila dipilih: langganan berstatus implementasi dibuat di transaksi yang sama.</span>
        </div>
      ) : null}
      {instance === "prod" ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono">prod</span>
          <input name="prod_host" maxLength={253} placeholder="host override (default <slug>.erp.bimacreative.tech)" className={`${input} w-96`} />
          <label className="ml-4">
            <input type="checkbox" name="demo" /> juga <span className="font-mono">demo</span>
          </label>
          <input name="demo_host" maxLength={253} placeholder="host demo (wajib bila demo, *.erp.bimacreative.tech)" className={`${input} w-96`} />
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono">staging</span>
          <input name="staging_host" maxLength={253} placeholder="host override (default <slug>.staging.bimacreative.tech)" className={`${input} w-96`} />
        </div>
      )}
      <SubmitButton className="rounded border px-3 py-1 hover:bg-slate-100">Buat tenant &amp; jalankan provisioning</SubmitButton>
      <p className="text-xs text-slate-500">
        Satu rantai job: kc_org_ensure → per env [odoo_db_provision → odoo_route → odoo_sso_provision → odoo_tenant_config
        (compat)] → kc_user_ensure (undangan admin) → kc_user_set_roles (tenant-admin, Odoo admin) per env → odoo_user_ensure
        per env. Status per langkah tampil di halaman tenant.
      </p>
    </form>
  );
}

/**
 * "Daftarkan tenant yang sudah ada" (migrasi prod M8, superadmin): tenant yang sudah hidup (DB, route — boleh host
 * kustom —, SSO) dicatat tanpa provisioning. Server mengulang semua validasi (parseRegisterExistingForm + layanan
 * registerExistingTenant). Tidak ada rantai onboarding; job route/SSO untuk host kustom dinonaktifkan (route manual).
 */
function RegisterExistingForm({
  instance,
  plans,
  missingTypes,
}: {
  instance: Instance;
  plans: { id: string; code: string; name: string }[];
  missingTypes: readonly BridgeJobType[];
}) {
  return (
    <form action={registerExistingTenantAction} className="mt-4 space-y-3 rounded border bg-white p-4 text-sm">
      <h2 className="font-semibold">Daftarkan tenant yang sudah ada</h2>
      <p className="text-xs text-slate-500">
        Untuk tenant yang sudah berjalan di luar control plane (DB, route, SSO sudah ada). Tidak ada provisioning DB/route/SSO.
        Nama DB wajib sesuai konvensi <span className="font-mono">&lt;slug, &apos;-&apos;→&apos;_&apos;&gt;_&lt;env&gt;</span>. Host boleh
        kustom (mis. <span className="font-mono">erp.klien.co.id</span>) — environment seperti itu bertanda {MANUAL_ROUTE_NOTE}
        (job route/SSO dinonaktifkan).
      </p>
      <div className="flex flex-wrap gap-2">
        <input name="slug" required maxLength={30} pattern="[a-z0-9-]{3,30}" placeholder="slug (bukan platform)" className={input} />
        <input name="name" required maxLength={200} placeholder="nama tenant" className={input} />
        <input name="brand" maxLength={100} placeholder="brand (opsional)" className={input} />
      </div>
      {plans.length > 0 ? (
        <label className="block">
          Plan Odoo{" "}
          <select name="plan_id" defaultValue="" className={input}>
            <option value="">— tanpa langganan (atur nanti di Subscriptions) —</option>
            {plans.map((p) => (
              <option key={p.id} value={p.id}>
                {p.code} — {p.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {INSTANCE_ENVS[instance].map((kind) => (
        <fieldset key={kind} className="flex flex-wrap items-center gap-2 rounded border p-2">
          <label>
            <input type="checkbox" name={kind} defaultChecked={kind !== "demo"} /> <span className="font-mono">{kind}</span>
          </label>
          <input name={`${kind}_db_name`} maxLength={63} pattern="[a-z0-9_]{1,63}" placeholder={dbNameFor("<slug>", kind)} className={`${input} font-mono`} />
          <input name={`${kind}_host`} maxLength={253} placeholder="host (mis. erp.klien.co.id)" className={`${input} w-72`} />
          <label>
            DB{" "}
            <select name={`${kind}_db_status`} defaultValue="provisioned" className={input}>
              <option value="provisioned">provisioned</option>
            </select>
          </label>
          <label>
            Route{" "}
            <select name={`${kind}_route_status`} defaultValue="active" className={input}>
              <option value="active">active</option>
            </select>
          </label>
          <label>
            SSO{" "}
            <select name={`${kind}_sso_status`} defaultValue="active" className={input}>
              <option value="active">active</option>
              <option value="none">none</option>
            </select>
          </label>
        </fieldset>
      ))}
      {missingTypes.length > 0 ? (
        <p role="status" className="rounded bg-amber-50 p-2 text-xs text-amber-800">
          Belum ada di allowlist <span className="font-mono">INFRA_JOBS_TYPES</span>: {missingTypes.join(", ")} — langkah itu dilewati
          (baris data tetap dicatat).
        </p>
      ) : null}
      <SubmitButton className="rounded border px-3 py-1 hover:bg-slate-100">Daftarkan tenant</SubmitButton>
      <p className="text-xs text-slate-500">
        Rantai job: kc_org_ensure → odoo_tenant_config (compat) per env ber-SSO aktif. Satu transaksi + audit
        tenant.register_existing.
      </p>
    </form>
  );
}

export default async function ClientsPage(props: PageProps<"/clients">) {
  const session = await requirePermission("clients:list");
  const sp = await props.searchParams;
  const params = parseClientListParams(sp);
  const r = parseActionResult(sp.r);
  const { rows, total } = await listClients(params);
  const env = getWebEnv();
  const instance = env.INFRA_JOBS_INSTANCE;
  const canManage = can(session.roles, "clients:manage");
  const allowedTypes = instanceJobTypes(env.INFRA_JOBS_TYPES);
  const onboardingOn = canManage && instance !== undefined && typesEnabled(allowedTypes, ONBOARDING_TYPES);
  // Pendaftaran tenant lama: tidak bergantung allowlist (tanpa tipe yang diizinkan → baris data saja).
  const registerOn = canManage && instance !== undefined;
  const registerMissing = REGISTER_EXISTING_TYPES.filter((t) => !allowedTypes.includes(t));
  // Plan aktif layanan odoo — hanya untuk pemegang billing:manage (layanan memeriksa ulang).
  const odooPlans =
    (onboardingOn || registerOn) && can(session.roles, "billing:manage")
      ? (await listPlans()).filter((p) => p.isActive && p.service === "odoo").map((p) => ({ id: p.id, code: p.code, name: p.name }))
      : [];

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
              <th className="p-2">Status</th>
              <th className="p-2">Dibuat</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={4} className="p-2 text-slate-500">
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
                    {c.isPlatform ? <span className="ml-1 text-xs text-slate-500">(internal)</span> : null}
                  </td>
                  <td className="p-2">{c.name}</td>
                  <td className="p-2">
                    <StatusBadge value={c.status} />
                  </td>
                  <td className="p-2">{c.createdAt.toISOString().slice(0, 10)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
        <p className="mt-2 text-xs text-slate-500">
          Total {total} · halaman {params.page} · {PAGE_SIZE}/halaman
        </p>
        {onboardingOn && instance ? <OnboardingForm instance={instance} plans={odooPlans} /> : null}
        {registerOn && instance ? <RegisterExistingForm instance={instance} plans={odooPlans} missingTypes={registerMissing} /> : null}
        {canManage && !onboardingOn ? (
          <p role="status" className="mt-4 rounded bg-amber-50 p-3 text-sm text-amber-800">
            &quot;Tenant baru&quot; nonaktif di instance ini ({instance ?? "INFRA_JOBS_INSTANCE kosong"}): tipe job onboarding belum
            semuanya ada di allowlist <span className="font-mono">INFRA_JOBS_TYPES</span>.
          </p>
        ) : null}
        {canManage ? (
          <form action={createClientAction} className="mt-4 flex flex-wrap items-center gap-2 rounded border bg-white p-4 text-sm">
            <span className="font-semibold">Tambah client (data saja, tanpa provisioning)</span>
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
