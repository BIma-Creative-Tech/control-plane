import "server-only";
import { sql } from "drizzle-orm";
import { PgBoss, fromDrizzle } from "pg-boss";
import { getWebEnv } from "@/env";
import type { SendFn } from "@/jobs/service";
import { BCTONE_OTP_QUEUE_OPTIONS, INFRA_JOB_QUEUE_OPTIONS, QUEUE_BCTONE_OTP, QUEUE_INFRA_JOB, type InfraJobMessage } from "@/jobs/queue";
import { logger } from "@/lib/logger";

/**
 * Klien pg-boss di proses web — HANYA untuk `send` (enqueue transaksional). Tanpa migrasi skema,
 * supervisor, atau cron (dikerjakan worker). Pool 1 koneksi (anggaran CONNECTION LIMIT role).
 */
const g = globalThis as unknown as { __cpBoss?: Promise<PgBoss> };

async function startBoss(): Promise<PgBoss> {
  const boss = new PgBoss({
    connectionString: getWebEnv().DATABASE_URL,
    schema: "pgboss",
    application_name: "control-plane-web-boss",
    max: 1,
    migrate: false,
    supervise: false,
    schedule: false,
  });
  boss.on("error", (err: Error) => logger.error({ err: err.message }, "pg-boss (web) error"));
  await boss.start();
  await boss.createQueue(QUEUE_INFRA_JOB, INFRA_JOB_QUEUE_OPTIONS);
  await boss.createQueue(QUEUE_BCTONE_OTP, BCTONE_OTP_QUEUE_OPTIONS);
  return boss;
}

export function getBoss(): Promise<PgBoss> {
  g.__cpBoss ??= startBoss().catch((err: unknown) => {
    g.__cpBoss = undefined;
    throw err;
  });
  return g.__cpBoss;
}

/** BCTOne registrasi: minta worker membuat & mengirim OTP (pesan hanya berisi id). */
export async function requestRegistrationOtp(registrationId: string): Promise<void> {
  const boss = await getBoss();
  await boss.send(QUEUE_BCTONE_OTP, { registrationId }, { ...BCTONE_OTP_QUEUE_OPTIONS, singletonKey: registrationId, singletonSeconds: 30 });
}

/** SendFn: pesan pg-boss ditulis di transaksi Drizzle yang sama dengan INSERT provision_jobs (outbox). */
export async function getSendFn(): Promise<SendFn> {
  const boss = await getBoss();
  return (tx, provisionJobId) =>
    boss.send(QUEUE_INFRA_JOB, { provisionJobId } satisfies InfraJobMessage, {
      db: fromDrizzle(tx, sql),
      ...INFRA_JOB_QUEUE_OPTIONS,
    });
}
