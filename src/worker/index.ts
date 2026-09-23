/**
 * Worker pg-boss (proses terpisah dari web). Entry: dist/worker/index.mjs.
 * API pg-boss 12.33.6 diverifikasi dari node_modules/pg-boss/dist/index.d.ts & README:
 * new PgBoss(options) → start() → createQueue(name) (idempotent) → work(name, async (jobs[]) => …).
 */
import { writeFile } from "node:fs/promises";
import { eq, sql } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import { createDb } from "../db/client";
import { provisionJobs } from "../db/schema";
import { getWorkerEnv } from "../env";
import { logger } from "../lib/logger";
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

  const beat = async () => {
    try {
      await writeFile(HEARTBEAT_FILE, String(Date.now()));
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, "heartbeat gagal");
    }
  };
  await beat();
  const timer = setInterval(() => void beat(), 15_000);

  logger.info({ queues: [QUEUE_NOOP] }, "worker siap");

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, "worker berhenti");
    clearInterval(timer);
    await boss.stop({ graceful: true, timeout: 20_000 });
    await pool.end();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err: unknown) => {
  logger.fatal({ err: err instanceof Error ? err.message : String(err) }, "worker gagal start");
  process.exit(1);
});
