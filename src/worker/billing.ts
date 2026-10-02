/**
 * Pendaftaran `subscription_tick` di worker (ADR 0018 D5): pg-boss schedule harian 00:15 Asia/Jakarta (`missed: once` —
 * worker mati saat 00:15 → satu tick saat hidup lagi), antrean `exclusive` (satu tick antre/aktif). TICK_NOW hanya
 * dihormati di instance staging (lib/billing.ts tickToday) — di staging dengan TICK_NOW, satu tick dikirim saat boot.
 */
import { sql } from "drizzle-orm";
import { fromDrizzle, type PgBoss } from "pg-boss";
import type { Logger } from "pino";
import type { Db } from "../db/client";
import type { WorkerEnv } from "../env";
import { createSmtpMailer, type Mailer } from "../billing/mailer";
import { runSubscriptionTick, type TickReport } from "../billing/tick";
import { tickToday } from "../lib/billing";
import { instanceJobTypes } from "../lib/job-contract";
import { INFRA_JOB_QUEUE_OPTIONS, QUEUE_INFRA_JOB, type InfraJobMessage } from "../jobs/queue";
import type { SendFn } from "../jobs/service";

export const QUEUE_SUBSCRIPTION_TICK = "subscription-tick";
export const SUBSCRIPTION_TICK_CRON = "15 0 * * *";
export const SUBSCRIPTION_TICK_TZ = "Asia/Jakarta";

type BillingEnv = Pick<
  WorkerEnv,
  | "INFRA_JOBS_INSTANCE"
  | "INFRA_JOBS_TYPES"
  | "TICK_NOW"
  | "SMTP_HOST"
  | "SMTP_PORT"
  | "SMTP_USER"
  | "SMTP_PASSWORD_FILE"
  | "SMTP_TLS"
  | "SMTP_FROM"
  | "BILLING_EMAIL"
>;

export function mailerFromEnv(env: BillingEnv): Mailer | null {
  if (!env.SMTP_HOST) return null;
  return createSmtpMailer({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    user: env.SMTP_USER,
    passwordFile: env.SMTP_PASSWORD_FILE,
    from: env.SMTP_FROM,
    tls: env.SMTP_TLS,
  });
}

/** SendFn worker: pesan infra-job ditulis di transaksi Drizzle yang sama (outbox). */
export function workerSendFn(boss: PgBoss): SendFn {
  return (tx, provisionJobId) =>
    boss.send(QUEUE_INFRA_JOB, { provisionJobId } satisfies InfraJobMessage, { db: fromDrizzle(tx, sql), ...INFRA_JOB_QUEUE_OPTIONS });
}

export function createTickRunner(deps: { db: Db; boss: PgBoss; env: BillingEnv; logger: Pick<Logger, "info" | "warn" | "error">; mailer?: Mailer | null }) {
  const mailer = deps.mailer === undefined ? mailerFromEnv(deps.env) : deps.mailer;
  const send = workerSendFn(deps.boss);
  return async (now = new Date()): Promise<TickReport> => {
    const t = tickToday(deps.env, now);
    if (t.ignored) deps.logger.warn("TICK_NOW diabaikan (hanya berlaku untuk INFRA_JOBS_INSTANCE=staging)");
    if (t.injected) deps.logger.warn({ today: t.today }, "subscription_tick memakai TICK_NOW (staging)");
    return runSubscriptionTick({
      db: deps.db,
      send,
      instance: deps.env.INFRA_JOBS_INSTANCE,
      allowedTypes: instanceJobTypes(deps.env.INFRA_JOBS_TYPES),
      logger: deps.logger,
      mailer,
      billingEmail: deps.env.BILLING_EMAIL,
      now,
      today: t.today,
    });
  };
}

export async function registerSubscriptionTick(
  boss: PgBoss,
  deps: { db: Db; env: BillingEnv; logger: Pick<Logger, "info" | "warn" | "error">; mailer?: Mailer | null },
  options: { pollingIntervalSeconds?: number } = {},
): Promise<void> {
  const run = createTickRunner({ ...deps, boss });
  await boss.createQueue(QUEUE_SUBSCRIPTION_TICK, { policy: "exclusive", retryLimit: 0, expireInSeconds: 1800 });
  await boss.schedule(QUEUE_SUBSCRIPTION_TICK, SUBSCRIPTION_TICK_CRON, null, { tz: SUBSCRIPTION_TICK_TZ, missed: "once" });
  await boss.work(QUEUE_SUBSCRIPTION_TICK, { batchSize: 1, ...options }, async () => {
    await run();
  });
  if (deps.env.INFRA_JOBS_INSTANCE === "staging" && deps.env.TICK_NOW) {
    await boss.send(QUEUE_SUBSCRIPTION_TICK, {});
  }
  if (!deps.env.SMTP_HOST) deps.logger.info("email pengingat nonaktif (SMTP_HOST kosong)");
}
