/**
 * Worker "bridge" (plan 05 §3–§4, ADR 0009):
 *  - dispatch(id)  handler pg-boss: validasi ulang baris provision_jobs dengan kontrak Zod → status
 *                  `dispatched` (+deadline) → tulis file job atomik ke spool. Tanpa retry.
 *  - collect()     baca results/<id>.json untuk job aktif → `running` / final (succeeded|failed + error_code),
 *                  RESULT ter-allowlist + tail teredaksi → rekonsiliasi environment/tenant_user_access → audit.
 *  - advanceChains() rantai (kontrak Fase 1 §2.1): job `queued` dengan after_job_id → di-dispatch bila pendahulu
 *                  `succeeded`; pendahulu `failed|cancelled` → `cancelled` + error_code `chain_aborted` (berantai).
 *  - watchdog()    job aktif lewat deadline → failed `no_result`; job `queued` yang tidak pernah
 *                  di-dispatch (pesan pg-boss hilang / pendahulu sukses tapi tidak dilanjutkan) → failed `no_result`.
 * Worker TIDAK menjalankan skrip, tidak punya Docker API/SSH/secret. Satu-satunya efek ke host = file spool.
 */
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Logger } from "pino";
import type { Db } from "../db/client";
import { safeErrorMessage } from "../db/errors";
import { auditLogs, environments, provisionJobs, users } from "../db/schema";
import { applyReconcile, planReconcile } from "../jobs/reconcile";
import { applyTenantReconcile, planTenantReconcile } from "../jobs/tenant-reconcile";
import { applyUserReconcile, planUserReconcile } from "../jobs/user-reconcile";
import type { Tx } from "../jobs/service";
import {
  BRIDGE_JOB_TYPES,
  ContractError,
  INSTANCE_ENVS,
  buildJobFile,
  dispatchDeadline,
  emailHash,
  isBridgeJobType,
  isSaasP1JobType,
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
      targetType: job.environmentId ? "environment" : "job",
      targetId: job.environmentId ?? job.id,
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
          actorUserId: provisionJobs.actorUserId,
        });
      const job = updated[0];
      if (!job) return false;
      let final = { status: outcome.status, errorCode: outcome.errorCode };
      if (isSaasP1JobType(job.type) && job.env) {
        // Kontrak Fase 1 §2.3: users/clients/tenant_user_access dari RESULT (id KC = sub).
        const ujob = {
          id: job.id,
          type: job.type,
          env: job.env,
          dryRun: job.dryRun,
          clientId: job.clientId,
          actorUserId: job.actorUserId,
          args: ((job.payload as { args?: Record<string, unknown> }).args ?? {}) as Record<string, unknown>,
          status: outcome.status,
          result: parsed?.result ?? {},
        };
        const plan = planUserReconcile(ujob);
        const extra = await applyUserReconcile(tx, ujob, plan);
        for (const w of [...plan.warnings, ...extra]) logger.warn({ jobId: job.id, type: job.type }, w);
        // ADR 0018 / kontrak §1.1: tenant_suspend|resume → clients.status, odoo_tenant_config → environments.tenant_check.
        const tplan = planTenantReconcile(ujob);
        await applyTenantReconcile(tx, tplan);
        for (const w of tplan.warnings) logger.warn({ jobId: job.id, type: job.type }, w);
      } else if (job.environmentId && isBridgeJobType(job.type) && job.env) {
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
          afterJobId: provisionJobs.afterJobId,
          actorUserId: provisionJobs.actorUserId,
        })
        .from(provisionJobs)
        .where(and(eq(provisionJobs.id, provisionJobId), eq(provisionJobs.status, "queued")))
        .for("update")
        .limit(1);
      const row = rows[0];
      if (!row) return { kind: "skipped" as const };
      if (row.afterJobId) {
        // Rantai: hanya bila pendahulu sudah `succeeded` (pesan pg-boss nyasar / dispatch terlalu awal → tunggu).
        const prev = await tx
          .select({ status: provisionJobs.status })
          .from(provisionJobs)
          .where(eq(provisionJobs.id, row.afterJobId))
          .limit(1);
        if (prev[0]?.status !== "succeeded") return { kind: "skipped" as const };
      }
      const payload = row.payload as { slug?: unknown; args?: unknown };
      // Temuan QA F1.1 (pertahanan berlapis, setelah cek enqueueChain): kc_user_ensure adopt=true hanya bila aktor
      // job tercatat superadmin (cache role users). Baris yang disisipkan langsung ke DB tanpa aktor sah → ditolak.
      if (row.type === "kc_user_ensure" && (payload.args as { adopt?: unknown } | null | undefined)?.adopt === true) {
        const actorRow = row.actorUserId
          ? (await tx.select({ role: users.role, status: users.status }).from(users).where(eq(users.id, row.actorUserId)).limit(1))[0]
          : undefined;
        if (actorRow?.role !== "superadmin" || actorRow.status === "disabled") return { kind: "invalid" as const, issue: "adopt_actor" };
      }
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

  const prevJob = alias(provisionJobs, "prev_job");

  /**
   * Rantai (kontrak Fase 1 §2.1). Batalkan dulu (berantai, ≤ 12 tingkat per tick) job yang pendahulunya
   * failed/cancelled, lalu dispatch job yang pendahulunya succeeded. Idempoten: cancel/dispatch hanya dari `queued`.
   */
  async function advanceChains(): Promise<{ cancelled: number; dispatched: number }> {
    let cancelled = 0;
    for (let depth = 0; depth < 12; depth++) {
      const doomed = await db
        .select({ id: provisionJobs.id, prevId: prevJob.id, prevStatus: prevJob.status, prevError: prevJob.errorCode })
        .from(provisionJobs)
        .innerJoin(prevJob, eq(prevJob.id, provisionJobs.afterJobId))
        .where(
          and(
            eq(provisionJobs.status, "queued"),
            isNotNull(provisionJobs.afterJobId),
            inArray(provisionJobs.type, bridgeTypes),
            inArray(provisionJobs.env, envs),
            inArray(prevJob.status, ["failed", "cancelled"]),
          ),
        )
        .limit(200);
      if (doomed.length === 0) break;
      for (const d of doomed) {
        const ok = await db.transaction(async (tx) => {
          const upd = await tx
            .update(provisionJobs)
            .set({
              status: "cancelled",
              errorCode: "chain_aborted",
              error: `rantai dihentikan: job sebelumnya ${d.prevId} ${d.prevStatus}${d.prevError ? ` (${d.prevError})` : ""}`,
              finishedAt: now(),
            })
            .where(and(eq(provisionJobs.id, d.id), eq(provisionJobs.status, "queued")))
            .returning({
              id: provisionJobs.id,
              type: provisionJobs.type,
              clientId: provisionJobs.clientId,
              environmentId: provisionJobs.environmentId,
              dryRun: provisionJobs.dryRun,
            });
          const job = upd[0];
          if (!job) return false;
          await tx.insert(auditLogs).values({
            actor: SYSTEM_ACTOR,
            action: "job.chain_aborted",
            targetType: job.environmentId ? "environment" : "job",
            targetId: job.environmentId ?? job.id,
            clientId: job.clientId,
            result: "failure",
            metadata: { job_id: job.id, type: job.type, after_job_id: d.prevId, after_status: d.prevStatus, error_code: "chain_aborted" },
          });
          return true;
        });
        if (ok) {
          cancelled++;
          logger.warn({ jobId: d.id, after: d.prevId }, "job rantai dibatalkan (chain_aborted)");
        }
      }
    }
    const ready = await db
      .select({ id: provisionJobs.id })
      .from(provisionJobs)
      .innerJoin(prevJob, eq(prevJob.id, provisionJobs.afterJobId))
      .where(
        and(
          eq(provisionJobs.status, "queued"),
          inArray(provisionJobs.type, bridgeTypes),
          inArray(provisionJobs.env, envs),
          eq(prevJob.status, "succeeded"),
        ),
      )
      .orderBy(provisionJobs.createdAt)
      .limit(50);
    let dispatched = 0;
    for (const r of ready) {
      if ((await dispatch(r.id)) === "dispatched") dispatched++;
    }
    return { cancelled, dispatched };
  }

  async function watchdog(): Promise<number> {
    const at = now();
    const queuedCutoff = new Date(at.getTime() - opts.queueGraceSeconds * 1000);
    const overdue = await db
      .select({ id: provisionJobs.id, status: provisionJobs.status })
      .from(provisionJobs)
      .where(
        and(
          inArray(provisionJobs.type, bridgeTypes),
          inArray(provisionJobs.env, envs),
          // Job rantai yang menunggu pendahulu (aktif) BUKAN overdue; dihitung dari selesainya pendahulu.
          sql`(
            (${provisionJobs.status} IN ('dispatched', 'running') AND ${provisionJobs.deadlineAt} < ${at})
            OR (${provisionJobs.status} = 'queued' AND ${provisionJobs.afterJobId} IS NULL AND ${provisionJobs.createdAt} < ${queuedCutoff})
            OR (${provisionJobs.status} = 'queued' AND ${provisionJobs.afterJobId} IS NOT NULL AND EXISTS (
              SELECT 1 FROM ${provisionJobs} AS wd_prev
              WHERE wd_prev.id = ${provisionJobs.afterJobId} AND wd_prev.status = 'succeeded' AND wd_prev.finished_at < ${queuedCutoff}
            ))
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
      await advanceChains();
      await watchdog();
    } catch (err) {
      logger.error({ err: safeErrorMessage(err) }, "tick bridge gagal");
    }
  }

  return { dispatch, collect, advanceChains, watchdog, tick };
}

export type Bridge = ReturnType<typeof createBridge>;
