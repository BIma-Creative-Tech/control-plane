/**
 * Enqueue `tenant_suspend` / `tenant_resume` (kontrak Fase 1 §1, ADR 0018 D4/D6) DI DALAM transaksi pemanggil — outbox:
 * transisi subscription + baris provision_jobs + audit + pesan pg-boss ter-commit bersama atau tidak sama sekali.
 * Dipakai subscription_tick (aktor `system:subscription-tick`) dan aksi "tandai lunas" (aktor user).
 *
 * Satu job per environment tenant yang dilayani instance ini (prod-inst: prod+demo; staging-inst: staging) dengan route
 * aktif — env tanpa route tidak punya file route untuk dirender ulang. Idempotency key `<type>:<slug>:<env>:tenant`
 * (job-contract.ts): job aktif dengan kunci sama dipakai ulang; job final melepas kuncinya.
 */
import { and, count, eq, gte, inArray, sql } from "drizzle-orm";
import { auditLogs, environments, provisionJobs } from "../db/schema";
import {
  BRIDGE_JOB_TYPES,
  INSTANCE_ENVS,
  idempotencyKey,
  validateJobRequest,
  type BridgeJobType,
  type Instance,
} from "../lib/job-contract";
import { evaluateChainQuota, type ChainQuotaViolation } from "../lib/quota";
import type { RequestMeta, SendFn, Tx } from "./service";

export type TenantStateType = "tenant_suspend" | "tenant_resume";

export interface TenantStateInput {
  instance: Instance | undefined;
  allowedTypes: readonly BridgeJobType[];
  client: { id: string; slug: string };
  type: TenantStateType;
  /** `system:subscription-tick` atau `user:<sub>`. */
  actorLabel: string;
  actorUserId: string | null;
  meta: RequestMeta;
  /** Konteks audit (mis. subscription_id, invoice_id, alasan). */
  context: Record<string, unknown>;
  now: Date;
}

export type TenantStateOutcome =
  | { kind: "enqueued"; jobIds: string[]; reused: number }
  /** Fitur nonaktif di instance ini — transisi DB tetap jalan, dicatat di audit pemanggil. */
  | { kind: "skipped"; reason: "no_instance" | "type_not_allowed" | "no_environment" };

/** Gagal di dalam transaksi → pemanggil me-rollback transisi (dicoba ulang tick berikutnya). */
export class TenantStateError extends Error {
  /** `busy` (QA N8): job kebalikan (suspend ↔ resume) masih aktif untuk tenant ini — dicoba lagi nanti. */
  constructor(readonly reason: "invalid" | "quota" | "duplicate" | "busy", readonly detail: string | ChainQuotaViolation) {
    super(`tenant_state ${reason}: ${detail}`);
  }
}

const ACTIVE = ["queued", "dispatched", "running"] as const;

export async function enqueueTenantStateTx(tx: Tx, send: SendFn, input: TenantStateInput): Promise<TenantStateOutcome> {
  if (!input.instance) return { kind: "skipped", reason: "no_instance" };
  if (!input.allowedTypes.includes(input.type)) return { kind: "skipped", reason: "type_not_allowed" };
  const instance = input.instance;
  const envs = await tx
    .select({ id: environments.id, kind: environments.kind })
    .from(environments)
    .where(
      and(
        eq(environments.clientId, input.client.id),
        inArray(environments.kind, [...INSTANCE_ENVS[instance]]),
        eq(environments.routeStatus, "active"),
      ),
    )
    .orderBy(environments.kind);
  if (envs.length === 0) return { kind: "skipped", reason: "no_environment" };

  // QA N8: cek kebalikan aktif yang SAMA dengan suspend/resume manual (jobs/tenants.ts setTenantState): kunci advisory
  // per tenant (kunci yang sama) lalu tolak bila tenant_resume/tenant_suspend kebalikannya masih aktif.
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`tenant-state:${input.client.id}`}))`);
  const opposite: TenantStateType = input.type === "tenant_suspend" ? "tenant_resume" : "tenant_suspend";
  const busy = await tx
    .select({ id: provisionJobs.id })
    .from(provisionJobs)
    .where(and(eq(provisionJobs.clientId, input.client.id), eq(provisionJobs.type, opposite), inArray(provisionJobs.status, [...ACTIVE])))
    .limit(1);
  if (busy[0]) throw new TenantStateError("busy", busy[0].id);

  const plans: { envId: string; env: (typeof envs)[number]["kind"]; key: string; reuse: string | null }[] = [];
  for (const e of envs) {
    const v = validateJobRequest(instance, { type: input.type, slug: input.client.slug, env: e.kind, dryRun: false, args: {} });
    if (!v.ok) throw new TenantStateError("invalid", v.issue);
    const key = idempotencyKey(v.value);
    if (!key) throw new TenantStateError("invalid", "idempotency_key");
    const existing = (
      await tx
        .select({ id: provisionJobs.id, status: provisionJobs.status, env: provisionJobs.env })
        .from(provisionJobs)
        .where(eq(provisionJobs.idempotencyKey, key))
        .for("update")
        .limit(1)
    )[0];
    let reuse: string | null = null;
    if (existing) {
      if ((ACTIVE as readonly string[]).includes(existing.status)) {
        if (existing.env !== e.kind) throw new TenantStateError("duplicate", existing.id);
        reuse = existing.id;
      } else {
        await tx.update(provisionJobs).set({ idempotencyKey: null }).where(eq(provisionJobs.id, existing.id));
      }
    }
    plans.push({ envId: e.id, env: e.kind, key, reuse });
  }

  const fresh = plans.filter((p) => p.reuse === null);
  if (fresh.length > 0) {
    // Kuota = dispatcher (tenant_state_per_day 20, total/jam 60). Hanya langkah tenant_state yang relevan.
    const hourAgo = new Date(input.now.getTime() - 3600_000);
    const dayAgo = new Date(input.now.getTime() - 86_400_000);
    const one = async (where: ReturnType<typeof and>) => (await tx.select({ n: count() }).from(provisionJobs).where(where))[0]?.n ?? 0;
    const violation = evaluateChainQuota(
      {
        totalLastHour: await one(and(inArray(provisionJobs.type, [...BRIDGE_JOB_TYPES]), gte(provisionJobs.createdAt, hourAgo))),
        tenantStateLastDay: await one(
          and(inArray(provisionJobs.type, ["tenant_suspend", "tenant_resume"]), gte(provisionJobs.createdAt, dayAgo)),
        ),
        kcUserLastHour: 0,
        kcUserDisableLastHour: 0,
        kcActionEmailLastHour: 0,
        kcRealmSyncLastDay: 0,
        odooUserLastHour: 0,
        actorChainsLastMinute: 0,
      },
      fresh.map(() => ({ type: input.type, dryRun: false, args: {} })),
    );
    if (violation) throw new TenantStateError("quota", violation);
  }

  const jobIds: string[] = [];
  for (const p of plans) {
    if (p.reuse) {
      jobIds.push(p.reuse);
      continue;
    }
    const id = (
      await tx
        .insert(provisionJobs)
        .values({
          type: input.type,
          status: "queued",
          clientId: input.client.id,
          environmentId: p.envId,
          env: p.env,
          dryRun: false,
          payload: { slug: input.client.slug, args: {} },
          actorUserId: input.actorUserId,
          actor: input.actorLabel,
          createdAt: input.now,
          idempotencyKey: p.key,
        })
        .returning({ id: provisionJobs.id })
    )[0]?.id;
    if (!id) throw new Error("insert provision_jobs tanpa id");
    await tx.insert(auditLogs).values({
      actorUserId: input.actorUserId,
      actor: input.actorLabel,
      action: `job.enqueue.${input.type}`,
      targetType: "environment",
      targetId: p.envId,
      clientId: input.client.id,
      result: "success",
      ip: input.meta.ip,
      requestId: input.meta.requestId,
      metadata: { type: input.type, env: p.env, dry_run: false, job_id: id, ...input.context },
    });
    const bossId = await send(tx, id);
    if (bossId) await tx.update(provisionJobs).set({ bossJobId: bossId }).where(eq(provisionJobs.id, id));
    jobIds.push(id);
  }
  return { kind: "enqueued", jobIds, reused: plans.length - fresh.length };
}
