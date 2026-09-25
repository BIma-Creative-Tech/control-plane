/**
 * Worker pg-boss (proses terpisah dari web). Entry: dist/worker/index.mjs.
 * API pg-boss 12.33.6 diverifikasi dari node_modules/pg-boss/dist/index.d.ts & README:
 * new PgBoss(options) → start() → createQueue(name, options) (idempotent) → work(name, async (jobs[]) => …).
 *
 * Jembatan infra-job (plan 05, ADR 0009) aktif HANYA bila INFRA_JOBS_SPOOL_DIR/RESULTS_DIR/INSTANCE diisi
 * (compose J3: bind mount spool rw + results ro, uid cpjob-<inst>). Tanpa itu worker berperilaku seperti
 * sebelumnya (hanya `noop`) — kompatibel dengan compose lama.
 */
import { writeFile } from "node:fs/promises";
import { eq, sql } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import { createDb } from "../db/client";
import { safeErrorMessage } from "../db/errors";
import { provisionJobs } from "../db/schema";
import { getWorkerEnv } from "../env";
import { INFRA_JOB_QUEUE_OPTIONS, QUEUE_INFRA_JOB } from "../jobs/queue";
import { logger } from "../lib/logger";
import { createBridge } from "./bridge";
import { registerInfraJobWorker } from "./register";
import { QUEUE_NOOP, handleNoop, parseNoopPayload } from "./jobs";

const HEARTBEAT_FILE = process.env.WORKER_HEARTBEAT_FILE ?? "/tmp/worker-heartbeat";

async function main(): Promise<void> {
  const env = getWorkerEnv();
  const { db, pool } = createDb(env.DATABASE_URL, { max: 2, applicationName: "control-plane-worker" });

  const boss = new PgBoss({
    connectionString: env.DATABASE_URL,
    schema: "pgboss",
    application_name: "control-plane-worker-boss",
    max: 3,
  });
  boss.on("error", (err: Error) => logger.error({ err: err.message }, "pg-boss error"));

  await boss.start();
  await boss.createQueue(QUEUE_NOOP);
  // Antrean dibuat selalu (idempotent) agar Server Action web bisa enqueue walau jembatan nonaktif;
  // job lalu tertahan `queued` dan terlihat di UI.
  await boss.createQueue(QUEUE_INFRA_JOB, INFRA_JOB_QUEUE_OPTIONS);

  await boss.work(QUEUE_NOOP, async (jobs) => {
    for (const job of jobs) {
      const payload = parseNoopPayload(job.data);
      if (payload.provisionJobId) {
        await db
          .update(provisionJobs)
          .set({ status: "running", startedAt: new Date(), attempts: sql`${provisionJobs.attempts} + 1` })
          .where(eq(provisionJobs.id, payload.provisionJobId));
      }
      const result = await handleNoop(payload);
      if (payload.provisionJobId) {
        await db
          .update(provisionJobs)
          .set({ status: "succeeded", finishedAt: new Date(), log: "noop ok" })
          .where(eq(provisionJobs.id, payload.provisionJobId));
      }
      logger.info({ jobId: job.id, queue: QUEUE_NOOP, slug: result.slug }, "job selesai");
    }
  });

  const queues = [QUEUE_NOOP];
  let bridgeTimer: NodeJS.Timeout | undefined;
  if (env.INFRA_JOBS_SPOOL_DIR && env.INFRA_JOBS_RESULTS_DIR && env.INFRA_JOBS_INSTANCE) {
    const bridge = createBridge({
      db,
      instance: env.INFRA_JOBS_INSTANCE,
      spoolDir: env.INFRA_JOBS_SPOOL_DIR,
      resultsDir: env.INFRA_JOBS_RESULTS_DIR,
      queueGraceSeconds: env.INFRA_JOBS_QUEUE_GRACE_SECONDS,
      logger,
    });
    await registerInfraJobWorker(boss, bridge, logger);
    let busy = false;
    bridgeTimer = setInterval(() => {
      if (busy) return;
      busy = true;
      void bridge.tick().finally(() => {
        busy = false;
      });
    }, env.INFRA_JOBS_POLL_SECONDS * 1000);
    await bridge.tick();
    queues.push(QUEUE_INFRA_JOB);
    logger.info({ instance: env.INFRA_JOBS_INSTANCE, pollSeconds: env.INFRA_JOBS_POLL_SECONDS }, "jembatan infra-job aktif");
  } else {
    logger.info("jembatan infra-job nonaktif (INFRA_JOBS_* tidak diisi)");
  }

  const beat = async () => {
    try {
      await writeFile(HEARTBEAT_FILE, String(Date.now()));
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, "heartbeat gagal");
    }
  };
  await beat();
  const timer = setInterval(() => void beat(), 15_000);

  logger.info({ queues }, "worker siap");

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, "worker berhenti");
    clearInterval(timer);
    if (bridgeTimer) clearInterval(bridgeTimer);
    await boss.stop({ graceful: true, timeout: 20_000 });
    await pool.end();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err: unknown) => {
  logger.fatal({ err: safeErrorMessage(err) }, "worker gagal start");
  process.exit(1);
});
