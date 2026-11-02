import type { ReactNode } from "react";
import { COMPANY, LEGAL_EFFECTIVE_DATE } from "@/lib/company";

/**
 * Kerangka halaman legal publik (/syarat, /privasi). STATIS: tanpa DB/sesi; CSP ber-nonce dari proxy.ts berlaku.
 * Gaya mengikuti suspended/notice.tsx (kartu putih, teks slate).
 */
export function LegalPage(props: { title: string; children: ReactNode; other: { href: string; label: string } }) {
  return (
    <main className="mx-auto my-12 max-w-3xl rounded-lg border bg-white p-8 text-sm leading-relaxed text-slate-700 shadow-sm">
      <p className="text-xs uppercase tracking-wide text-slate-500">
        {COMPANY.product} · {COMPANY.legalName}
      </p>
      <h1 className="mt-1 text-xl font-semibold text-slate-900">{props.title}</h1>
      <p className="mt-1 text-xs text-slate-500">Berlaku sejak {LEGAL_EFFECTIVE_DATE}</p>
      <div className="mt-6 space-y-5">{props.children}</div>
      <p className="mt-8 border-t pt-4 text-xs text-slate-500">
        Pertanyaan: <a href={`mailto:${COMPANY.supportEmail}`} className="underline">{COMPANY.supportEmail}</a> ·{" "}
        <a href={props.other.href} className="underline">
          {props.other.label}
        </a>{" "}
        · <a href="/daftar" className="underline">Daftar BCTOne</a>
      </p>
    </main>
  );
}

export function Section(props: { n: number; title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="font-semibold text-slate-900">
        {props.n}. {props.title}
      </h2>
      {props.children}
    </section>
  );
}
