/**
 * Layanan enqueue job jembatan infra-job (plan 05 §4–§5). Dipanggil Server Action (web) dan test.
 * Satu transaksi: validasi kontrak + otorisasi tingkat aksi + prasyarat + kuota → INSERT provision_jobs
 * (partial unique index = satu job aktif per environment+type) → tenant_user_access → audit_logs →
 * pesan pg-boss (dalam transaksi yang SAMA, lewat `send(tx, …)`) — semua atau tidak sama sekali.
 * Tidak ada child_process/Docker/SSH/secret: eksekusi hanya oleh dispatcher root (ADR 0009).
 */
import { and, count, eq, gte, inArray, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { isUniqueViolation, safeErrorMessage } from "../db/errors";
import { auditLogs, clients, environments, provisionJobs, tenantUserAccess } from "../db/schema";
import {
  BRIDGE_JOB_TYPES,
  defaultHost,
  emailHash,
  envAllowedForInstance,
  validateJobRequest,
  type BridgeJobType,
  type ContractIssue,
  type Instance,
  type JobArgs,
  type JobRequest,
} from "../lib/job-contract";
import { evaluateQuota, type QuotaViolation } from "../lib/quota";
import { can, type Role } from "../lib/roles";

export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
/** Kirim pesan pg-boss dalam transaksi `tx`; mengembalikan id job pg-boss. */
export type SendFn = (tx: Tx, provisionJobId: string) => Promise<string | null>;

export interface Actor {
  /** Klaim `sub` Keycloak. */
  sub: string;
  userId: string | null;
  roles: readonly Role[];
}

export interface RequestMeta {
  ip: string | null;
  requestId: string | null;
}

export interface EnqueueInput {
  instance: Instance;
  environmentId: string;
  type: BridgeJobType;
  dryRun: boolean;
  args: unknown;
  actor: Actor;
  meta: RequestMeta;
  parentJobId?: string | null;
}

export type EnqueueFailure =
  | { reason: "forbidden" }
  | { reason: "not_found" }
  | { reason: "invalid"; issue: ContractIssue }
  | { reason: "precondition"; detail: PreconditionIssue }
  | { reason: "quota"; violation: QuotaViolation }
  | { reason: "duplicate" }
  | { reason: "error"; message: string };

export type PreconditionIssue = "route_not_active" | "host_not_in_route" | "user_not_listed" | "job_not_retryable";

export type EnqueueOutcome = { ok: true; jobId: string } | ({ ok: false } & EnqueueFailure);

const ACTIVE_STATUSES = ["queued", "dispatched", "running"] as const;

/** Aksi yang wajib `jobs:odoo_admin` (superadmin) — plan 05 §4.2/§5.1. */
export function requiresAdmin(type: BridgeJobType, args: unknown): boolean {
  const a = (args ?? {}) as Record<string, unknown>;
  if (type === "odoo_sso_disable") return true;
  if (type === "odoo_route" && a.remove === true) return true;
  if (type === "odoo_sso_provision" && a.rotate_secret === true) return true;
  return false;
}

class Abort extends Error {
  constructor(readonly failure: EnqueueFailure) {
    super(failure.reason);
  }
}

function auditMetadata(req: JobRequest, jobId: string | null, extra: Record<string, unknown> = {}) {
  const a = req.args as Record<string, unknown>;
  const md: Record<string, unknown> = { type: req.type, env: req.env, dry_run: req.dryRun, ...extra };
  if (jobId) md.job_id = jobId;
  if (req.type === "odoo_sso_user") {
    md.action = a.action;
    md.email_hash = emailHash(String(a.email));
    md.admin = a.admin;
    md.create_kc = a.create_kc;
  }
  if (req.type === "odoo_route") md.remove = a.remove;
  if (req.type === "odoo_sso_provision") {
    md.rotate_secret = a.rotate_secret;
    md.skip_smoke = a.skip_smoke;
  }
  if ("host" in a && typeof a.host === "string") md.host = a.host;
  if ("hosts" in a && Array.isArray(a.hosts)) md.hosts = a.hosts;
  return md;
}

async function quotaCounts(tx: Tx, actorLabel: string, now: Date) {
  const hourAgo = new Date(now.getTime() - 3600_000);
  const dayAgo = new Date(now.getTime() - 86_400_000);
  const minuteAgo = new Date(now.getTime() - 60_000);
  const bridge = inArray(provisionJobs.type, [...BRIDGE_JOB_TYPES]);
  const one = async (where: ReturnType<typeof and>) =>
    (await tx.select({ n: count() }).from(provisionJobs).where(where))[0]?.n ?? 0;
  return {
    totalLastHour: await one(and(bridge, gte(provisionJobs.createdAt, hourAgo))),
    dbProvisionLastDay: await one(
      and(eq(provisionJobs.type, "odoo_db_provision"), eq(provisionJobs.dryRun, false), gte(provisionJobs.createdAt, dayAgo)),
    ),
    ssoUserLastHour: await one(and(eq(provisionJobs.type, "odoo_sso_user"), gte(provisionJobs.createdAt, hourAgo))),
    rotateSecretLastDay: await one(
      and(
        eq(provisionJobs.type, "odoo_sso_provision"),
        sql`${provisionJobs.payload} -> 'args' ->> 'rotate_secret' = 'true'`,
        gte(provisionJobs.createdAt, dayAgo),
      ),
    ),
    actorLastMinute: await one(and(bridge, eq(provisionJobs.actor, actorLabel), gte(provisionJobs.createdAt, minuteAgo))),
  };
}

/** Audit penolakan (di luar transaksi utama yang di-rollback). Gagal audit tidak menggagalkan respons. */
async function auditRejected(
  db: Db,
  input: EnqueueInput,
  clientId: string | null,
  failure: EnqueueFailure,
  req: JobRequest | null,
): Promise<void> {
  try {
    await db.insert(auditLogs).values({
      actorUserId: input.actor.userId,
      actor: `user:${input.actor.sub}`,
      action: `job.enqueue.${input.type}`,
      targetType: "environment",
      targetId: input.environmentId,
      clientId,
      result: "rejected",
      ip: input.meta.ip,
      requestId: input.meta.requestId,
      metadata: {
        ...(req ? auditMetadata(req, null) : { type: input.type }),
        reason: failure.reason,
        ...("violation" in failure ? { violation: failure.violation } : {}),
        ...("issue" in failure ? { issue: failure.issue } : {}),
        ...("detail" in failure ? { detail: failure.detail } : {}),
      },
    });
  } catch {
    // diabaikan: penolakan tetap dikembalikan ke pemanggil
  }
}

export async function enqueueBridgeJob(db: Db, send: SendFn, input: EnqueueInput, now = new Date()): Promise<EnqueueOutcome> {
  const actorLabel = `user:${input.actor.sub}`;
  if (!can(input.actor.roles, "jobs:odoo")) return { ok: false, reason: "forbidden" };

  const envRows = await db
    .select({
      id: environments.id,
      clientId: environments.clientId,
      kind: environments.kind,
      host: environments.host,
      routeStatus: environments.routeStatus,
      slug: clients.slug,
      terminatedAt: clients.terminatedAt,
    })
    .from(environments)
    .innerJoin(clients, eq(clients.id, environments.clientId))
    .where(eq(environments.id, input.environmentId))
    .limit(1);
  const envRow = envRows[0];
  if (!envRow || envRow.terminatedAt) return { ok: false, reason: "not_found" };

  const fail = async (failure: EnqueueFailure, req: JobRequest | null): Promise<EnqueueOutcome> => {
    await auditRejected(db, input, envRow.clientId, failure, req);
    return { ok: false, ...failure };
  };

  if (!envAllowedForInstance(input.instance, envRow.kind)) {
    return fail({ reason: "invalid", issue: "env_instance" }, null);
  }
  const v = validateJobRequest(input.instance, {
    type: input.type,
    slug: envRow.slug,
    env: envRow.kind,
    dryRun: input.dryRun,
    args: input.args,
  });
  if (!v.ok) return fail({ reason: "invalid", issue: v.issue }, null);
  const req = v.value;

  if (requiresAdmin(req.type, req.args) && !can(input.actor.roles, "jobs:odoo_admin")) {
    return fail({ reason: "forbidden" }, req);
  }

  // Prasyarat CP (dispatcher tetap memeriksa file route root-owned): host SSO ⊆ host route aktif.
  if (req.type === "odoo_sso_provision" || req.type === "odoo_sso_disable") {
    const a = req.args as JobArgs["odoo_sso_provision"] | JobArgs["odoo_sso_disable"];
    const skipSmoke = req.type === "odoo_sso_provision" && (a as JobArgs["odoo_sso_provision"]).skip_smoke;
    if (skipSmoke) {
      if (a.hosts[0] !== defaultHost(envRow.slug, envRow.kind)) return fail({ reason: "invalid", issue: "skip_smoke_host" }, req);
    } else {
      if (envRow.routeStatus !== "active" || !envRow.host) {
        return fail({ reason: "precondition", detail: "route_not_active" }, req);
      }
      if (!a.hosts.every((h) => h === envRow.host)) return fail({ reason: "precondition", detail: "host_not_in_route" }, req);
    }
  }

  try {
    const jobId = await db.transaction(async (tx) => {
      const counts = await quotaCounts(tx, actorLabel, now);
      const rotate = req.type === "odoo_sso_provision" && (req.args as JobArgs["odoo_sso_provision"]).rotate_secret;
      const violation = evaluateQuota(counts, { type: req.type, rotateSecret: rotate });
      if (violation) throw new Abort({ reason: "quota", violation });

      let tuaRowId: string | null = null;
      if (req.type === "odoo_sso_user") {
        const a = req.args as JobArgs["odoo_sso_user"];
        const existing = await tx
          .select({ id: tenantUserAccess.id })
          .from(tenantUserAccess)
          .where(and(eq(tenantUserAccess.environmentId, envRow.id), eq(tenantUserAccess.email, a.email)))
          .limit(1);
        tuaRowId = existing[0]?.id ?? null;
        if (a.action !== "grant" && !tuaRowId) throw new Abort({ reason: "precondition", detail: "user_not_listed" });
      }

      const inserted = await tx
        .insert(provisionJobs)
        .values({
          type: req.type,
          status: "queued",
          clientId: envRow.clientId,
          environmentId: envRow.id,
          env: envRow.kind,
          dryRun: req.dryRun,
          payload: { slug: req.slug, args: req.args as Record<string, unknown> },
          actorUserId: input.actor.userId,
          actor: actorLabel,
          parentJobId: input.parentJobId ?? null,
          createdAt: now,
        })
        .returning({ id: provisionJobs.id });
      const id = inserted[0]?.id;
      if (!id) throw new Error("insert provision_jobs tanpa id");

      if (req.type === "odoo_sso_user" && !req.dryRun) {
        const a = req.args as JobArgs["odoo_sso_user"];
        if (a.action === "grant") {
          await tx
            .insert(tenantUserAccess)
            .values({
              environmentId: envRow.id,
              email: a.email,
              odooLogin: a.login ?? null,
              isTenantAdmin: a.admin,
              status: "pending",
              invitedBy: input.actor.userId,
              lastJobId: id,
            })
            .onConflictDoUpdate({
              target: [tenantUserAccess.environmentId, tenantUserAccess.email],
              set: {
                odooLogin: a.login ?? null,
                isTenantAdmin: a.admin,
                status: "pending",
                invitedBy: input.actor.userId,
                lastJobId: id,
                updatedAt: sql`now()`,
              },
            });
        } else if (tuaRowId) {
          await tx
            .update(tenantUserAccess)
            .set({ lastJobId: id, updatedAt: sql`now()` })
            .where(eq(tenantUserAccess.id, tuaRowId));
        }
      }

      await tx.insert(auditLogs).values({
        actorUserId: input.actor.userId,
        actor: actorLabel,
        action: `job.enqueue.${req.type}`,
        targetType: "environment",
        targetId: envRow.id,
        clientId: envRow.clientId,
        result: "success",
        ip: input.meta.ip,
        requestId: input.meta.requestId,
        metadata: auditMetadata(req, id, input.parentJobId ? { parent_job_id: input.parentJobId } : {}),
      });

      const bossId = await send(tx, id);
      if (bossId) await tx.update(provisionJobs).set({ bossJobId: bossId }).where(eq(provisionJobs.id, id));
      return id;
    });
    return { ok: true, jobId };
  } catch (err) {
    if (err instanceof Abort) return fail(err.failure, req);
    if (isUniqueViolation(err, "provision_jobs_one_active_uq")) return fail({ reason: "duplicate" }, req);
    // Pesan aman (kode SQLSTATE, tanpa query/params) untuk log pemanggil.
    return { ok: false, reason: "error", message: safeErrorMessage(err) };
  }
}

/**
 * "Ulangi" (plan 05 §4.4): job baru dengan payload sama + parent_job_id. Hanya job final `failed`/`cancelled`;
 * `timeout_state_unknown` hanya superadmin (jobs:odoo_admin).
 */
export async function retryBridgeJob(
  db: Db,
  send: SendFn,
  input: { instance: Instance; jobId: string; actor: Actor; meta: RequestMeta },
  now = new Date(),
): Promise<EnqueueOutcome> {
  if (!can(input.actor.roles, "jobs:odoo")) return { ok: false, reason: "forbidden" };
  const rows = await db
    .select({
      id: provisionJobs.id,
      type: provisionJobs.type,
      status: provisionJobs.status,
      environmentId: provisionJobs.environmentId,
      dryRun: provisionJobs.dryRun,
      payload: provisionJobs.payload,
      errorCode: provisionJobs.errorCode,
    })
    .from(provisionJobs)
    .where(eq(provisionJobs.id, input.jobId))
    .limit(1);
  const job = rows[0];
  if (!job || !job.environmentId || !(BRIDGE_JOB_TYPES as readonly string[]).includes(job.type)) {
    return { ok: false, reason: "not_found" };
  }
  if (job.status !== "failed" && job.status !== "cancelled") {
    return { ok: false, reason: "precondition", detail: "job_not_retryable" };
  }
  if (job.errorCode === "timeout_state_unknown" && !can(input.actor.roles, "jobs:odoo_admin")) {
    return { ok: false, reason: "forbidden" };
  }
  return enqueueBridgeJob(
    db,
    send,
    {
      instance: input.instance,
      environmentId: job.environmentId,
      type: job.type as BridgeJobType,
      dryRun: job.dryRun,
      args: (job.payload as { args?: unknown }).args,
      actor: input.actor,
      meta: input.meta,
      parentJobId: job.id,
    },
    now,
  );
}

export { ACTIVE_STATUSES };
