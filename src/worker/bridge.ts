/**
 * Worker "bridge" (plan 05 §3–§4, ADR 0009):
 *  - dispatch(id)  handler pg-boss: validasi ulang baris provision_jobs dengan kontrak Zod → status
 *                  `dispatched` (+deadline) → tulis file job atomik ke spool. Tanpa retry.
 *  - collect()     baca results/<id>.json untuk job aktif → `running` / final (succeeded|failed + error_code),
 *                  RESULT ter-allowlist + tail teredaksi → rekonsiliasi environment/tenant_user_access → audit.
 *  - watchdog()    job aktif lewat deadline → failed `no_result`; job `queued` yang tidak pernah
 *                  di-dispatch (pesan pg-boss hilang) → failed `no_result`.
 * Worker TIDAK menjalankan skrip, tidak punya Docker API/SSH/secret. Satu-satunya efek ke host = file spool.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Logger } from "pino";
import type { Db } from "../db/client";
import { safeErrorMessage } from "../db/errors";
import { auditLogs, environments, provisionJobs } from "../db/schema";
import { applyReconcile, planReconcile } from "../jobs/reconcile";
import type { Tx } from "../jobs/service";
import {
  BRIDGE_JOB_TYPES,
  ContractError,
  INSTANCE_ENVS,
  buildJobFile,
  dispatchDeadline,
  emailHash,
  isBridgeJobType,
  mapFinalOutcome,
  parseResultFile,
  runningDeadline,
  type BridgeJobType,
  type ErrorCode,
  type Instance,
  type ParsedResult,
  type TenantEnv,
} from "../lib/job-contract";
import { SpoolError, readResultFile, writeJobFileAtomic } from "./spool";

export interface BridgeOptions {
  db: Db;
  instance: Instance;
  spoolDir: string;
  resultsDir: string;
  queueGraceSeconds: number;
  logger: Pick<Logger, "info" | "warn" | "error">;
  now?: () => Date;
}

const ACTIVE = ["dispatched", "running"] as const;
const SYSTEM_ACTOR = "system:worker";

export function createBridge(opts: BridgeOptions) {
  const { db, instance, spoolDir, resultsDir, logger } = opts;
  const now = opts.now ?? (() => new Date());
  const envs = [...INSTANCE_ENVS[instance]] as TenantEnv[];
  const bridgeTypes = [...BRIDGE_JOB_TYPES];
  /** Hindari banjir log untuk file hasil rusak yang sama. */
  const warnedInvalid = new Set<string>();

  async function auditFinish(
    tx: Tx,
    job: { id: string; type: string; clientId: string | null; environmentId: string | null; dryRun: boolean },
    status: "succeeded" | "failed",
    errorCode: ErrorCode | null,
    exitCode: number | null,
  ) {
    await tx.insert(auditLogs).values({
      actor: SYSTEM_ACTOR,
      action: "job.finish",
      targetType: "environment",
      targetId: job.environmentId,
      clientId: job.clientId,
      result: status === "succeeded" ? "success" : "failure",
      metadata: { job_id: job.id, type: job.type, state: status, error_code: errorCode, exit_code: exitCode, dry_run: job.dryRun },
    });
  }

  /**
   * BUG-J5-01: RESULT tidak cocok dengan aksi diminta → job `failed`/`result_inconsistent` (bukan sukses diam-diam)
   * + audit `job.result_inconsistent` (alert; tanpa email mentah) + log error. Baris tenant_user_access sudah
   * ditandai `inconsistent` oleh applyReconcile.
   */
  async function markInconsistent(
    tx: Tx,
    job: { id: string; type: string; clientId: string | null; environmentId: string | null; dryRun: boolean; payload: unknown },
    info: { expected: string; reported: string | null },
    reportedState: "succeeded" | "failed",
  ) {
    const reported = info.reported ?? "(tidak ada)";
    await tx
      .update(provisionJobs)
      .set({
        status: "failed",
        errorCode: "result_inconsistent",
        error: `RESULT action=${reported} tidak cocok dengan aksi diminta ${info.expected} (state dispatcher: ${reportedState}); periksa akses user di Keycloak/Odoo`,
      })
      .where(eq(provisionJobs.id, job.id));
    const args = ((job.payload as { args?: Record<string, unknown> } | null)?.args ?? {}) as Record<string, unknown>;
    await tx.insert(auditLogs).values({
      actor: SYSTEM_ACTOR,
      action: "job.result_inconsistent",
      targetType: "environment",
      targetId: job.environmentId,
      clientId: job.clientId,
      result: "failure",
      metadata: {
        job_id: job.id,
        type: job.type,
        dry_run: job.dryRun,
        expected_action: info.expected,
        result_action: info.reported,
        dispatcher_state: reportedState,
        ...(typeof args.email === "string" ? { email_hash: emailHash(args.email) } : {}),
      },
    });
    logger.error(
      { jobId: job.id, type: job.type, expected: info.expected, reported: info.reported, alert: "job_result_inconsistent" },
      "RESULT job tidak konsisten dengan aksi yang diminta — status akses ditandai inconsistent",
    );
  }

  /** Finalisasi idempoten: hanya baris yang masih aktif (atau queued untuk watchdog) yang diubah. */
  async function finalize(
    jobId: string,
    fromStatuses: readonly ("queued" | "dispatched" | "running")[],
    outcome: { status: "succeeded" | "failed"; errorCode: ErrorCode | null; error?: string | null },
    parsed: ParsedResult | null,
  ): Promise<boolean> {
    return db.transaction(async (tx) => {
      const updated = await tx
        .update(provisionJobs)
        .set({
          status: outcome.status,
          errorCode: outcome.errorCode,
          error: outcome.error ?? null,
          exitCode: parsed?.exitCode ?? null,
          result: parsed ? parsed.result : null,
          log: parsed ? parsed.tail.join("\n") : "",
          startedAt: sql`coalesce(${provisionJobs.startedAt}, ${parsed?.startedAt ?? null})`,
          finishedAt: parsed?.finishedAt ?? now(),
        })
        .where(and(eq(provisionJobs.id, jobId), inArray(provisionJobs.status, [...fromStatuses])))
        .returning({
          id: provisionJobs.id,
          type: provisionJobs.type,
          env: provisionJobs.env,
          dryRun: provisionJobs.dryRun,
          payload: provisionJobs.payload,
          clientId: provisionJobs.clientId,
          environmentId: provisionJobs.environmentId,
        });
      const job = updated[0];
      if (!job) return false;
      let final = { status: outcome.status, errorCode: outcome.errorCode };
      if (job.environmentId && isBridgeJobType(job.type) && job.env) {
        const envRow = await tx
          .select({ dbName: environments.dbName })
          .from(environments)
          .where(eq(environments.id, job.environmentId))
          .limit(1);
        if (envRow[0]) {
          const plan = planReconcile(
            {
              id: job.id,
              type: job.type,
              env: job.env,
              dryRun: job.dryRun,
              args: ((job.payload as { args?: Record<string, unknown> }).args ?? {}) as Record<string, unknown>,
              status: outcome.status,
              result: parsed?.result ?? {},
            },
            envRow[0],
          );
          for (const w of plan.warnings) logger.warn({ jobId: job.id, type: job.type }, w);
          await applyReconcile(tx, job.environmentId, job.id, plan);
          if (plan.inconsistent) {
            final = { status: "failed", errorCode: "result_inconsistent" };
            await markInconsistent(tx, job, plan.inconsistent, outcome.status);
          }
        }
      }
      await auditFinish(tx, job, final.status, final.errorCode, parsed?.exitCode ?? null);
      return true;
    });
  }

  async function dispatch(provisionJobId: string): Promise<"dispatched" | "skipped" | "rejected" | "spool_failed"> {
    const claimed = await db.transaction(async (tx) => {
      const rows = await tx
        .select({
          id: provisionJobs.id,
          type: provisionJobs.type,
          env: provisionJobs.env,
          dryRun: provisionJobs.dryRun,
          actor: provisionJobs.actor,
          createdAt: provisionJobs.createdAt,
          payload: provisionJobs.payload,
        })
        .from(provisionJobs)
        .where(and(eq(provisionJobs.id, provisionJobId), eq(provisionJobs.status, "queued")))
        .for("update")
        .limit(1);
      const row = rows[0];
      if (!row) return { kind: "skipped" as const };
      const payload = row.payload as { slug?: unknown; args?: unknown };
      try {
        const file = buildJobFile(instance, {
          id: row.id,
          type: row.type,
          slug: typeof payload.slug === "string" ? payload.slug : "",
          env: row.env,
          dryRun: row.dryRun,
          actor: row.actor,
          createdAt: row.createdAt,
          args: payload.args,
        });
        const at = now();
        await tx
          .update(provisionJobs)
          .set({
            status: "dispatched",
            dispatchedAt: at,
            deadlineAt: dispatchDeadline(file.type, at, opts.queueGraceSeconds),
            attempts: sql`${provisionJobs.attempts} + 1`,
          })
          .where(eq(provisionJobs.id, row.id));
        return { kind: "ok" as const, file };
      } catch (err) {
        if (err instanceof ContractError) return { kind: "invalid" as const, issue: err.issue };
        throw err;
      }
    });

    if (claimed.kind === "skipped") return "skipped";
    if (claimed.kind === "invalid") {
      logger.warn({ jobId: provisionJobId, issue: claimed.issue }, "job ditolak kontrak di worker (tidak ditulis ke spool)");
      await finalize(provisionJobId, ["queued"], {
        status: "failed",
        errorCode: "rejected_validation",
        error: `ditolak worker: ${claimed.issue}`,
      }, null);
      return "rejected";
    }
    try {
      await writeJobFileAtomic(spoolDir, claimed.file);
    } catch (err) {
      const code = err instanceof SpoolError ? err.code : "EIO";
      logger.error({ jobId: provisionJobId, code }, "gagal menulis spool");
      // Rename belum terjadi → dispatcher tidak akan pernah melihat job ini.
      await finalize(provisionJobId, ["dispatched"], { status: "failed", errorCode: "spool_error", error: `spool: ${code}` }, null);
      return "spool_failed";
    }
    logger.info({ jobId: provisionJobId, type: claimed.file.type, env: claimed.file.env }, "job ditulis ke spool");
    return "dispatched";
  }

  async function collect(): Promise<{ running: number; finished: number }> {
    const active = await db
      .select({ id: provisionJobs.id, type: provisionJobs.type, status: provisionJobs.status })
      .from(provisionJobs)
      .where(
        and(
          inArray(provisionJobs.status, [...ACTIVE]),
          inArray(provisionJobs.type, bridgeTypes),
          inArray(provisionJobs.env, envs),
        ),
      )
      .limit(200);
    let running = 0;
    let finished = 0;
    for (const job of active) {
      let text: string | null;
      try {
        text = await readResultFile(resultsDir, job.id);
      } catch (err) {
        if (!warnedInvalid.has(job.id)) {
          warnedInvalid.add(job.id);
          logger.warn({ jobId: job.id, code: err instanceof SpoolError ? err.code : "EIO" }, "file hasil tidak bisa dibaca");
        }
        continue;
      }
      if (text === null) continue;
      const parsed = parseResultFile(text, job.id);
      if (!parsed) {
        if (!warnedInvalid.has(job.id)) {
          warnedInvalid.add(job.id);
          logger.warn({ jobId: job.id }, "file hasil tidak valid (diabaikan; watchdog → no_result)");
        }
        continue;
      }
      if (parsed.unknownErrorCode) logger.warn({ jobId: job.id }, "error_code hasil tidak dikenal → script_exit");
      const outcome = mapFinalOutcome(parsed);
      if (!outcome) {
        if (job.status === "dispatched") {
          const started = parsed.startedAt ?? now();
          await db
            .update(provisionJobs)
            .set({
              status: "running",
              startedAt: started,
              deadlineAt: runningDeadline(job.type as BridgeJobType, started),
            })
            .where(and(eq(provisionJobs.id, job.id), eq(provisionJobs.status, "dispatched")));
          running++;
        }
        continue;
      }
      if (await finalize(job.id, ACTIVE, outcome, parsed)) {
        finished++;
        warnedInvalid.delete(job.id);
        logger.info({ jobId: job.id, status: outcome.status, errorCode: outcome.errorCode }, "job selesai");
      }
    }
    return { running, finished };
  }

  async function watchdog(): Promise<number> {
    const at = now();
    const overdue = await db
      .select({ id: provisionJobs.id, status: provisionJobs.status })
      .from(provisionJobs)
      .where(
        and(
          inArray(provisionJobs.type, bridgeTypes),
          inArray(provisionJobs.env, envs),
          sql`(
            (${provisionJobs.status} IN ('dispatched', 'running') AND ${provisionJobs.deadlineAt} < ${at})
            OR (${provisionJobs.status} = 'queued' AND ${provisionJobs.createdAt} < ${new Date(at.getTime() - opts.queueGraceSeconds * 1000)})
          )`,
        ),
      )
      .limit(200);
    let n = 0;
    for (const job of overdue) {
      // Hasil bisa baru saja tiba: coba collect sekali lagi sebelum menyerah.
      const text = job.status === "queued" ? null : await readResultFile(resultsDir, job.id).catch(() => null);
      const parsed = text ? parseResultFile(text, job.id) : null;
      const outcome = parsed ? mapFinalOutcome(parsed) : null;
      const ok = outcome
        ? await finalize(job.id, ACTIVE, outcome, parsed)
        : await finalize(
            job.id,
            job.status === "queued" ? ["queued"] : ACTIVE,
            {
              status: "failed",
              errorCode: "no_result",
              error: job.status === "queued" ? "tidak pernah di-dispatch" : "tidak ada hasil sebelum deadline",
            },
            null,
          );
      if (ok) {
        n++;
        logger.warn({ jobId: job.id, from: job.status }, outcome ? "job selesai (watchdog)" : "job no_result");
      }
    }
    return n;
  }

  /** Satu putaran collector + watchdog; error dicatat tanpa PII dan tidak menghentikan worker. */
  async function tick(): Promise<void> {
    try {
      await collect();
      await watchdog();
    } catch (err) {
      logger.error({ err: safeErrorMessage(err) }, "tick bridge gagal");
    }
  }

  return { dispatch, collect, watchdog, tick };
}

export type Bridge = ReturnType<typeof createBridge>;
