import Link from "next/link";

/** 404 sendiri: halaman bawaan Next memakai style inline yang diblokir CSP (style-src ber-nonce). */
export default function NotFound() {
  return (
    <main className="mx-auto mt-24 max-w-md rounded-2xl border bg-card p-8 text-center">
      <div className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">404</div>
      <h1 className="mt-2 font-heading text-2xl font-bold">Halaman tidak ditemukan</h1>
      <p className="mt-2 text-sm text-muted-foreground">Data tidak ada atau Anda tidak memiliki akses ke halaman ini.</p>
      <Link href="/dashboard" className="mt-6 inline-flex min-h-10 items-center rounded-xl bg-primary px-4 text-sm font-semibold text-primary-foreground">
        Kembali ke Dashboard
      </Link>
    </main>
  );
}
