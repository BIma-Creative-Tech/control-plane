/**
 * Isi halaman layanan ditangguhkan (ADR 0018 D6). STATIS: tidak membaca DB/sesi, tidak memantulkan slug dari URL —
 * respons identik untuk slug ada/tidak ada (tidak membocorkan keberadaan tenant). CSP ber-nonce dari proxy.ts berlaku.
 */
export function SuspendedNotice() {
  return (
    <main className="mx-auto mt-24 max-w-md rounded-lg border bg-white p-8 text-center shadow-sm">
      <h1 className="text-xl font-semibold">Layanan sedang ditangguhkan</h1>
      <p className="mt-3 text-slate-600">
        Akses ke layanan ini untuk sementara ditangguhkan. Data Anda tetap aman dan tidak dihapus.
      </p>
      <p className="mt-3 text-slate-600">
        Silakan hubungi administrator perusahaan Anda atau tim billing di{" "}
        <a href="mailto:billing@bimacreative.tech" className="underline">
          billing@bimacreative.tech
        </a>
        .
      </p>
    </main>
  );
}
