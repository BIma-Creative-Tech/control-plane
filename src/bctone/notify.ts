/**
 * BCTOne registrasi — email notifikasi (worker). Idempoten per key `notification_log` (billing/tick.ts sendOnce: kirim
 * paling banyak sekali, gagal dicoba ulang maks. 3x). Teks polos; tanpa data sensitif (tanpa OTP/harga rinci).
 *  - review/waitlist  → owner (BILLING_EMAIL): ada pendaftaran menunggu keputusan
 *  - done             → pendaftar: ERP siap + alamat login
 *  - rejected         → pendaftar: tidak dapat diproses (+ catatan owner)
 */
import { and, eq, gte, inArray } from "drizzle-orm";
import type { Logger } from "pino";
import type { Db } from "../db/client";
import { bctoneRegistrations, environments } from "../db/schema";
import { sendOnce } from "../billing/tick";
import type { Mailer } from "../billing/mailer";
import { envRouteHost } from "../lib/job-contract";
import { paymentAccountLine } from "../lib/company";
import { INDUSTRY_LABEL, TIER_LABEL, moduleName, type BctoneTier, type Industry } from "../lib/bctone-register";

export interface RegistrationNotice {
  key: string;
  kind: string;
  to: string[];
  subject: string;
  text: string;
  clientId: string | null;
}

type Row = typeof bctoneRegistrations.$inferSelect;

/** Murni: email untuk satu registrasi pada status saat ini (null = tidak ada email untuk status ini). */
export function composeRegistrationNotice(r: Row, opts: { ownerEmail: string; adminUrl: string; erpHost: string | null }): RegistrationNotice | null {
  const tier = r.tier ? TIER_LABEL[r.tier as BctoneTier] : "-";
  const sign = ["", "PT Bima Creative Tech"];
  switch (r.status) {
    case "review":
    case "waitlist":
      return {
        key: `bctone-reg:${r.id}:owner:${r.status}`,
        kind: `bctone_registration_${r.status}`,
        to: [opts.ownerEmail],
        clientId: null,
        subject: `[BCTOne] Pendaftaran ${r.status === "review" ? "menunggu review" : "masuk waitlist"}: ${r.businessName}`,
        text: [
          `Pendaftaran baru ${r.status === "review" ? "perlu ditinjau" : "masuk daftar tunggu (kapasitas penuh)"}.`,
          "",
          `Bisnis   : ${r.businessName} (${r.slug})`,
          `Pemilik  : ${r.ownerName} <${r.email}>`,
          `Usaha    : ${r.industry ? INDUSTRY_LABEL[r.industry as Industry] : "-"}, ${r.outlets ?? "-"} outlet`,
          `Paket    : ${tier}`,
          `Modul    : ${(r.modules ?? []).map(moduleName).join(", ") || "-"}`,
          `Lainnya  : ${r.extraNeeds ?? "-"}`,
          "",
          `Setujui atau tolak: ${opts.adminUrl}/registrations`,
        ].join("\n"),
      };
    case "done":
      return {
        key: `bctone-reg:${r.id}:welcome`,
        kind: "bctone_registration_welcome",
        to: [r.email],
        clientId: r.clientId,
        subject: "ERP BCTOne Anda siap",
        text: [
          `Halo ${r.ownerName},`,
          "",
          `ERP BCTOne untuk ${r.businessName} sudah siap (paket ${tier}).`,
          opts.erpHost ? `Alamat login: https://${opts.erpHost}` : "",
          "",
          "Anda juga menerima email undangan terpisah untuk membuat kata sandi. Setelah itu masuk lewat tombol SSO di",
          "halaman login. Kuota paket dan pilihan privasi AI dapat dilihat di Console.",
          ...(r.billingExempt
            ? ["", "Akun ini dibebaskan dari tagihan BCTOne."]
            : r.tier && r.tier !== "free"
            ? ["", "Tagihan terbit di Console › Tagihan. Pembayaran lewat transfer ke", paymentAccountLine() + ", lalu laporkan di Console."]
            : []),
          ...sign,
        ]
          .filter((l, i, a) => !(l === "" && a[i - 1] === ""))
          .join("\n"),
      };
    case "rejected":
      return {
        key: `bctone-reg:${r.id}:rejected`,
        kind: "bctone_registration_rejected",
        to: [r.email],
        clientId: null,
        subject: "Pendaftaran BCTOne Anda",
        text: [
          `Halo ${r.ownerName},`,
          "",
          `Mohon maaf, pendaftaran ${r.businessName} belum dapat kami proses saat ini.`,
          r.reviewNote ? `Catatan: ${r.reviewNote}` : "",
          "",
          "Balas email ini bila ada pertanyaan.",
          ...sign,
        ].join("\n"),
      };
    default:
      return null;
  }
}

/** Kirim notifikasi untuk registrasi yang berubah status dalam 7 hari terakhir (dedupe via notification_log). */
export async function notifyRegistrations(
  d: { db: Db; mailer: Mailer | null; logger: Pick<Logger, "info" | "warn" | "error">; ownerEmail: string; adminUrl: string },
  now = new Date(),
): Promise<number> {
  if (!d.mailer) return 0;
  const rows = await d.db
    .select()
    .from(bctoneRegistrations)
    .where(and(inArray(bctoneRegistrations.status, ["review", "waitlist", "done", "rejected"]), gte(bctoneRegistrations.updatedAt, new Date(now.getTime() - 7 * 86_400_000))))
    .limit(100);
  let sent = 0;
  for (const r of rows) {
    const env = r.clientId
      ? (await d.db.select({ host: environments.host, url: environments.url }).from(environments).where(eq(environments.clientId, r.clientId)).limit(1))[0]
      : undefined;
    const n = composeRegistrationNotice(r, { ownerEmail: d.ownerEmail, adminUrl: d.adminUrl, erpHost: env ? envRouteHost(env) : null });
    if (!n) continue;
    const res = await sendOnce({ db: d.db, mailer: d.mailer, now, logger: d.logger }, { ...n, subscriptionId: null, cc: [] });
    if (res === "sent") sent++;
  }
  return sent;
}
