/**
 * BCTOne registrasi — kirim OTP (worker). Kode dibuat DI SINI dan hanya hash bergaram yang disimpan; pesan antrean
 * hanya berisi id registrasi (kode tidak pernah lewat web, antrean, atau log). Email polos teks.
 */
import { and, eq, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import type { Logger } from "pino";
import type { Db } from "../db/client";
import { bctoneRegistrations } from "../db/schema";
import type { Mailer } from "../billing/mailer";
import { mailErrorCode } from "../billing/mailer";
import { OTP_PER_EMAIL_HOUR, OTP_TTL_SECONDS, generateOtp } from "../lib/bctone-register";
import { UUID_REGEX } from "../lib/job-contract";
import { BCTONE_OTP_QUEUE_OPTIONS, QUEUE_BCTONE_OTP } from "../jobs/queue";

export { QUEUE_BCTONE_OTP };

export interface OtpMessage {
  registrationId: string;
}

export type OtpSendResult = "sent" | "skipped" | "no_mailer" | "error";

export async function sendRegistrationOtp(db: Db, mailer: Mailer | null, id: string, now = new Date()): Promise<OtpSendResult> {
  if (!UUID_REGEX.test(id)) return "skipped";
  if (!mailer) return "no_mailer";
  const otp = generateOtp();
  // Klaim atomik: hanya draft, dan batas kirim per registrasi (OTP_PER_EMAIL_HOUR) — kirim ulang berlebihan diabaikan.
  const r = (
    await db
      .update(bctoneRegistrations)
      .set({
        otpHash: otp.hash,
        otpSalt: otp.salt,
        otpExpiresAt: new Date(now.getTime() + OTP_TTL_SECONDS * 1000),
        otpAttempts: 0,
        otpSends: sql`${bctoneRegistrations.otpSends} + 1`,
        updatedAt: now,
      })
      .where(and(eq(bctoneRegistrations.id, id), eq(bctoneRegistrations.status, "draft"), sql`${bctoneRegistrations.otpSends} < ${OTP_PER_EMAIL_HOUR}`))
      .returning({ email: bctoneRegistrations.email, ownerName: bctoneRegistrations.ownerName })
  )[0];
  if (!r) return "skipped";
  try {
    await mailer.send({
      to: [r.email],
      cc: [],
      subject: `Kode verifikasi BCTOne: ${otp.code}`,
      text: [
        `Halo ${r.ownerName},`,
        "",
        `Kode verifikasi pendaftaran BCTOne Anda: ${otp.code}`,
        `Berlaku ${Math.round(OTP_TTL_SECONDS / 60)} menit. Jangan berikan kode ini kepada siapa pun, termasuk staf BCT.`,
        "",
        "Bila Anda tidak mendaftar, abaikan email ini.",
        "",
        "PT Bima Creative Tech",
      ].join("\n"),
    });
    return "sent";
  } catch (err) {
    // email gagal → kode tidak berguna; hapus agar tidak bisa ditebak
    await db.update(bctoneRegistrations).set({ otpHash: null, otpSalt: null, otpExpiresAt: null }).where(eq(bctoneRegistrations.id, id));
    void mailErrorCode(err);
    return "error";
  }
}

export async function registerOtpWorker(boss: PgBoss, deps: { db: Db; mailer: Mailer | null; logger: Pick<Logger, "info" | "warn"> }): Promise<void> {
  await boss.createQueue(QUEUE_BCTONE_OTP, BCTONE_OTP_QUEUE_OPTIONS);
  await boss.work<OtpMessage>(QUEUE_BCTONE_OTP, { batchSize: 1 }, async (jobs) => {
    for (const job of jobs) {
      const id = (job.data as { registrationId?: unknown } | null)?.registrationId;
      const res = typeof id === "string" ? await sendRegistrationOtp(deps.db, deps.mailer, id) : "skipped";
      deps.logger.info({ queue: QUEUE_BCTONE_OTP, result: res }, "otp registrasi");
    }
  });
}
