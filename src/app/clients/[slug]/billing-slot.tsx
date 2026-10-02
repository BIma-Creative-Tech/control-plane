/**
 * ===================================================================================================
 * SLOT BILLING (W6/W7, branch feat/saas-p1-billing) — PLACEHOLDER.
 * Engineer billing mengganti isi komponen ini dengan panel Subscription & Invoice (migrasi 0005, ADR 0018 D4):
 * status langganan, Go-live, invoice terbuka/lunas. Kontrak props: `clientId` (clients.id) + `canManage`
 * (superadmin). Halaman tenant TIDAK membaca tabel subscriptions/invoices di luar slot ini.
 * ===================================================================================================
 */
export function BillingSlot({ clientId, canManage }: { clientId: string; canManage: boolean }) {
  return (
    <section
      data-slot="billing"
      data-client-id={clientId}
      data-can-manage={canManage ? "1" : "0"}
      className="rounded border border-dashed bg-white p-4 text-sm text-slate-500"
    >
      <h2 className="font-semibold text-slate-700">Subscription &amp; Invoice</h2>
      <p>Panel langganan dan invoice menyusul (SaaS Fase 1 W6/W7).</p>
    </section>
  );
}
