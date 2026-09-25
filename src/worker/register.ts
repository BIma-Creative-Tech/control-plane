import type { PgBoss } from "pg-boss";
import type { Logger } from "pino";
import { QUEUE_INFRA_JOB, type InfraJobMessage } from "../jobs/queue";
import { UUID_REGEX } from "../lib/job-contract";
import type { Bridge } from "./bridge";

/** Daftarkan handler pg-boss antrean infra-job → bridge.dispatch (dipakai worker & test integrasi). */
export async function registerInfraJobWorker(
  boss: PgBoss,
  bridge: Bridge,
  logger: Pick<Logger, "info" | "warn">,
  options: { pollingIntervalSeconds?: number } = {},
): Promise<string> {
  return boss.work<InfraJobMessage>(QUEUE_INFRA_JOB, { batchSize: 1, ...options }, async (jobs) => {
    for (const job of jobs) {
      const id = (job.data as { provisionJobId?: unknown } | null)?.provisionJobId;
      if (typeof id !== "string" || !UUID_REGEX.test(id)) {
        logger.warn({ bossJobId: job.id }, "pesan infra-job tidak valid (diabaikan)");
        continue;
      }
      const r = await bridge.dispatch(id);
      logger.info({ jobId: id, dispatch: r }, "infra-job dispatch");
    }
  });
}
