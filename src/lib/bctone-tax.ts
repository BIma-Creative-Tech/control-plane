/**
 * Pajak tagihan langganan BCTOne (ADR 0019, keputusan owner K-11/K-20) — modul MURNI, diuji unit.
 * Sumber aturan sama dengan paket `@bctone/rules` (repo bima-superapps-platform): bila berubah, ubah keduanya.
 *
 * BR-16: PPN = 12% x DPP nilai lain (11/12 x harga)  =>  efektif 11% dari harga, dibulatkan ke bawah ke rupiah penuh.
 * BR-17: PPh 23 = 2% x harga sebelum PPN, dipotong klien badan usaha (bukti potong wajib).
 * [S] Pembulatan & tarif dikonfirmasi konsultan pajak sebelum go-live.
 *
 * Nominal = string desimal (kolom numeric(14,2), AMOUNT_REGEX lib/billing.ts). Dihitung dengan BigInt sen agar
 * tidak ada galat floating point.
 */
import { AMOUNT_REGEX } from "./billing";

export const TAX_SCHEMES = ["none", "ppn_dpp_nilai_lain"] as const;
export type TaxScheme = (typeof TAX_SCHEMES)[number];

function toCents(amount: string): bigint {
  if (!AMOUNT_REGEX.test(amount)) throw new RangeError("nominal tidak valid");
  const [int, frac = ""] = amount.split(".");
  return BigInt(int ?? "0") * 100n + BigInt(frac.padEnd(2, "0"));
}

function fromCents(c: bigint): string {
  const neg = c < 0n;
  const a = neg ? -c : c;
  const s = `${a / 100n}.${String(a % 100n).padStart(2, "0")}`;
  return neg ? `-${s}` : s;
}

/** Bulatkan ke bawah ke rupiah penuh (sen = 0). */
function floorRupiah(c: bigint): bigint {
  return (c / 100n) * 100n;
}

export interface InvoiceTax {
  scheme: TaxScheme;
  /** Harga / DPP (= invoices.amount). */
  amount: string;
  ppnAmount: string;
  pph23Amount: string;
  /** amount + PPN. */
  totalAmount: string;
  /** Yang ditransfer klien = total - PPh 23. */
  payableAmount: string;
}

export function computeInvoiceTax(amount: string, opts: { scheme: TaxScheme; withholdPph23: boolean }): InvoiceTax {
  const base = toCents(amount);
  const ppn = opts.scheme === "ppn_dpp_nilai_lain" ? floorRupiah((base * 11n) / 100n) : 0n;
  const pph23 = opts.withholdPph23 ? floorRupiah((base * 2n) / 100n) : 0n;
  const total = base + ppn;
  return {
    scheme: opts.scheme,
    amount: fromCents(base),
    ppnAmount: fromCents(ppn),
    pph23Amount: fromCents(pph23),
    totalAmount: fromCents(total),
    payableAmount: fromCents(total - pph23),
  };
}
