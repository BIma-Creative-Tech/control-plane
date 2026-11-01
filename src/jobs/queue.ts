/**
 * Antrean pg-boss jembatan infra-job (plan 05 §4.4): TANPA retry otomatis (retryLimit 0).
 * "Ulangi" di UI = job CP baru dengan parent_job_id. Handler hanya menulis spool (detik), jadi
 * expireInSeconds kecil; eksekusi skrip dilacak lewat provision_jobs + file hasil, bukan pg-boss.
 */
export const QUEUE_INFRA_JOB = "infra-job-dispatch";

export const INFRA_JOB_QUEUE_OPTIONS = {
  retryLimit: 0,
  expireInSeconds: 120,
} as const;

/** BCTOne registrasi: worker membuat & mengirim OTP (pesan = id registrasi saja). */
export const QUEUE_BCTONE_OTP = "bctone-otp";
export const BCTONE_OTP_QUEUE_OPTIONS = { retryLimit: 0, expireInSeconds: 120 } as const;

export interface InfraJobMessage {
  provisionJobId: string;
}
