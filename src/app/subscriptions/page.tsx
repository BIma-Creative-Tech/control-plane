import Link from "next/link";
import { requirePermission } from "@/lib/authz";
import { SUBSCRIPTION_STATUS_LABELS, formatAmount, jakartaDate } from "@/lib/billing";
import { ACTION_RESULT_TEXT, parseActionResult } from "@/lib/job-list-params";
import { can } from "@/lib/roles";
import { SLUG_REGEX } from "@/lib/slug";
import { listBillingTenants, listPlans, listSubscriptions } from "@/server/billing-queries";
import { BillingBadge, btn, btnDanger, input } from "../billing/components";
import { ResultBanner } from "../jobs/components";
import { Nav } from "../nav";
import { createSubscriptionAction, goLiveAction, setSubscriptionPriceAction, terminateSubscriptionAction } from "./actions";

/**
 * Subscriptions (ADR 0018 D4/D7, W5). Lihat: superadmin/ops (`billing:view`); buat/Go-live/akhiri: superadmin
 * (`billing:manage`). Transisi otomatis (garansi → aktif → lewat jatuh tempo → ditangguhkan) dijalankan subscription_tick
 * harian di worker. Otorisasi diulang di setiap Server Action + layanan.
 */
export default async function SubscriptionsPage(props: PageProps<"/subscriptions">) {
  const session = await requirePermission("billing:view");
  const sp = await props.searchParams;
  const r = parseActionResult(sp.r);
  const rawTenant = typeof sp.tenant === "string" ? sp.tenant : "";
  const tenantParam = SLUG_REGEX.test(rawTenant) ? rawTenant : "";
  const canManage = can(session.roles, "billing:manage");

  const tenants = await listBillingTenants();
  const selected = tenantParam ? (tenants.find((t) => t.slug === tenantParam) ?? null) : null;
  const [rows, plans] = await Promise.all([listSubscriptions(selected?.id ?? null), listPlans()]);
  const today = jakartaDate(new Date());
  const selectedActive = selected !== null && selected.status !== "terminated" && selected.terminatedAt === null;

  return (
    <>
      <Nav session={session} />
      <main className="space-y-6 p-6">
        <h1 className="text-lg font-semibold">Subscriptions</h1>
        {r ? <ResultBanner code={r} text={ACTION_RESULT_TEXT[r]} jobId={null} /> : null}

        <form method="get" className="flex flex-wrap items-center gap-2 text-sm">
          <label>
            Tenant{" "}
            <select name="tenant" defaultValue={tenantParam} className={input}>
              <option value="">semua</option>
              {tenants.map((t) => (
                <option key={t.id} value={t.slug}>
                  {t.slug}
                  {t.status === "terminated" || t.terminatedAt ? " — terminated" : ""}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className={btn}>
            Filter
          </button>
          {selected ? (
            <Link href={`/invoices?tenant=${selected.slug}`} className="underline">
              Invoice tenant ini
            </Link>
          ) : null}
        </form>

        <table className="w-full border bg-white text-left text-sm">
          <thead className="bg-slate-100">
            <tr>
              <th className="p-2">Tenant</th>
              <th className="p-2">Plan</th>
              <th className="p-2">Harga / periode</th>
              <th className="p-2">Status</th>
              <th className="p-2">Go-live</th>
              <th className="p-2">Garansi s.d.</th>
              <th className="p-2">Periode (starts → ends)</th>
              <th className="p-2">Grace s.d.</th>
              <th className="p-2">Aksi</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={9} className="p-2 text-slate-500">
                  Belum ada langganan.
                </td>
              </tr>
            ) : (
              rows.map((s) => (
                <tr key={s.id} className="border-t align-top">
                  <td className="p-2 font-mono">
                    <Link href={`/subscriptions?tenant=${s.slug}`} className="underline">
                      {s.slug}
                    </Link>
                  </td>
                  <td className="p-2">
                    <span className="font-mono">{s.planCode}</span> <span className="text-xs text-slate-500">({s.service ?? "?"})</span>
                  </td>
                  <td className="p-2 whitespace-nowrap">
                    {s.subPriceAmount !== null ? (
                      <>
                        {formatAmount(s.subPriceAmount, s.subPriceCurrency ?? s.currency)}{" "}
                        <span className="text-xs text-slate-500">(override)</span>
                      </>
                    ) : s.priceAmount !== null ? (
                      <>
                        {formatAmount(s.priceAmount, s.currency)} <span className="text-xs text-slate-500">(plan)</span>
                      </>
                    ) : (
                      <span className="text-slate-500">belum ditetapkan</span>
                    )}
                  </td>
                  <td className="p-2">
                    <BillingBadge value={s.status} />
                  </td>
                  <td className="p-2 whitespace-nowrap">{s.goLiveAt ?? "—"}</td>
                  <td className="p-2 whitespace-nowrap">{s.warrantyUntil ?? "—"}</td>
                  <td className="p-2 whitespace-nowrap">{s.startsAt && s.endsAt ? `${s.startsAt} → ${s.endsAt}` : "—"}</td>
                  <td className="p-2 whitespace-nowrap">{s.graceUntil ?? "—"}</td>
                  <td className="space-y-2 p-2">
                    {canManage && s.status === "implementation" ? (
                      <form action={goLiveAction} className="flex flex-wrap items-center gap-1">
                        <input type="hidden" name="back" value={tenantParam} />
                        <input type="hidden" name="subscriptionId" value={s.id} />
                        <input type="date" name="goLiveAt" defaultValue={today} max={today} required className={input} />
                        <button type="submit" className={btn}>
                          Go-live
                        </button>
                        <span className="w-full text-xs text-slate-500">Garansi 2 bulan sejak tanggal go-live.</span>
                      </form>
                    ) : null}
                    {canManage && s.status !== "terminated" ? (
                      <details>
                        <summary className="cursor-pointer text-xs underline">Ubah harga…</summary>
                        <form action={setSubscriptionPriceAction} className="mt-2 flex flex-wrap items-center gap-1">
                          <input type="hidden" name="back" value={tenantParam} />
                          <input type="hidden" name="subscriptionId" value={s.id} />
                          <input
                            name="price_amount"
                            defaultValue={s.subPriceAmount ?? ""}
                            inputMode="decimal"
                            pattern="(0|[1-9][0-9]{0,11})(\.[0-9]{1,2})?"
                            placeholder="kosong = harga plan"
                            className={`${input} w-40`}
                          />
                          <input name="price_currency" defaultValue={s.subPriceCurrency ?? s.currency} maxLength={3} pattern="[A-Z]{3}" className={`${input} w-16`} />
                          <button type="submit" className={btn}>
                            Simpan
                          </button>
                          <span className="w-full text-xs text-slate-500">Berlaku untuk invoice maintenance berikutnya.</span>
                        </form>
                      </details>
                    ) : null}
                    {canManage && s.status !== "terminated" ? (
                      <details>
                        <summary className="cursor-pointer text-xs underline">Akhiri langganan…</summary>
                        <form action={terminateSubscriptionAction} className="mt-2 flex items-center gap-1">
                          <input type="hidden" name="back" value={tenantParam} />
                          <input type="hidden" name="subscriptionId" value={s.id} />
                          <label className="text-xs">
                            <input type="checkbox" name="confirm" required /> yakin
                          </label>
                          <button type="submit" className={btnDanger}>
                            Akhiri
                          </button>
                        </form>
                      </details>
                    ) : null}
                    {s.notes ? <p className="max-w-xs text-xs whitespace-pre-wrap text-slate-500">{s.notes}</p> : null}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>

        {canManage ? (
          selected && selectedActive ? (
            <form action={createSubscriptionAction} className="flex flex-wrap items-center gap-2 rounded border bg-white p-4 text-sm">
              <span className="font-semibold">
                Langganan baru untuk <span className="font-mono">{selected.slug}</span>
              </span>
              <input type="hidden" name="back" value={tenantParam} />
              <input type="hidden" name="clientId" value={selected.id} />
              <select name="planId" required className={input}>
                {plans
                  .filter((p) => p.isActive && p.service)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.code} ({p.service})
                    </option>
                  ))}
              </select>
              <input
                name="price_amount"
                inputMode="decimal"
                pattern="(0|[1-9][0-9]{0,11})(\.[0-9]{1,2})?"
                placeholder="harga override (opsional)"
                className={`${input} w-48`}
              />
              <input name="price_currency" defaultValue="IDR" maxLength={3} pattern="[A-Z]{3}" className={`${input} w-16`} />
              <input name="notes" maxLength={1000} placeholder="catatan (opsional)" className={`${input} min-w-64`} />
              <button type="submit" className={btn}>
                Buat (status {SUBSCRIPTION_STATUS_LABELS.implementation})
              </button>
              <p className="w-full text-xs text-slate-500">
                Satu langganan aktif per layanan per tenant. Invoice implementasi diterbitkan manual di halaman Invoices.
              </p>
            </form>
          ) : (
            <p className="text-sm text-slate-500">Pilih satu tenant aktif (filter) untuk membuat langganan.</p>
          )
        ) : null}

        <section className="space-y-2">
          <h2 className="font-semibold">Plan</h2>
          <table className="w-full border bg-white text-left text-sm">
            <thead className="bg-slate-100">
              <tr>
                <th className="p-2">Kode</th>
                <th className="p-2">Nama</th>
                <th className="p-2">Layanan</th>
                <th className="p-2">Harga / periode</th>
                <th className="p-2">Aktif</th>
              </tr>
            </thead>
            <tbody>
              {plans.map((p) => (
                <tr key={p.id} className="border-t">
                  <td className="p-2 font-mono">{p.code}</td>
                  <td className="p-2">{p.name}</td>
                  <td className="p-2">{p.service ?? "—"}</td>
                  <td className="p-2">
                    {p.priceAmount === null ? <span className="text-slate-500">belum ditetapkan</span> : formatAmount(p.priceAmount, p.currency)} /{" "}
                    {p.billingPeriodMonths} bln
                  </td>
                  <td className="p-2">{p.isActive ? "ya" : "tidak"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-xs text-slate-500">
            Invoice maintenance otomatis memakai harga override langganan, bila kosong harga plan. Keduanya NULL: tidak
            diterbitkan (dicatat di audit) — terbitkan manual di Invoices.
          </p>
        </section>
      </main>
    </>
  );
}
