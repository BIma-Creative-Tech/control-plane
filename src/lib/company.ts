/**
 * Identitas badan usaha & rekening pembayaran BCTOne — satu sumber untuk halaman legal (/syarat, /privasi), wizard
 * /daftar, Console › Tagihan, dan email tagihan. Bukan secret. Nama badan hukum ditulis PERSIS seperti di buku rekening
 * ("Technolgy" — keputusan pemilik 2026-11-01; jangan "dikoreksi" agar cocok dengan nama penerima transfer).
 */
export const COMPANY = {
  legalName: "PT. Bima Creative Technolgy",
  brand: "Bima Creative Tech (BCT)",
  product: "BCTOne",
  city: "Depok, Indonesia",
  billingEmail: "billing@bimacreative.tech",
  supportEmail: "billing@bimacreative.tech",
  website: "https://bimacreative.tech",
} as const;

export const PAYMENT_ACCOUNT = {
  bank: "Bank Mandiri",
  number: "157-00-1393580-5",
  holder: COMPANY.legalName,
} as const;

/** Satu baris instruksi transfer (UI & email). */
export function paymentAccountLine(): string {
  return `${PAYMENT_ACCOUNT.bank} ${PAYMENT_ACCOUNT.number} a.n. ${PAYMENT_ACCOUNT.holder}`;
}

/** Versi dokumen legal (tanggal berlaku) — naikkan bila isi /syarat atau /privasi berubah material. */
export const LEGAL_EFFECTIVE_DATE = "2 November 2026";
