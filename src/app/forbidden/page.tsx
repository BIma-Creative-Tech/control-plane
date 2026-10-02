import Link from "next/link";

export default function ForbiddenPage() {
  return (
    <main className="mx-auto mt-24 max-w-md p-8 text-center">
      <h1 className="text-xl font-semibold">Akses ditolak</h1>
      <p className="mt-2 text-slate-600">Akun Anda tidak memiliki izin untuk halaman ini.</p>
      <Link href="/" className="mt-4 inline-block underline">
        Kembali
      </Link>
    </main>
  );
}
