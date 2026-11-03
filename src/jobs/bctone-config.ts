/**
 * ADR 0019 #4 — enqueue `bctone_tenant_config` DI DALAM transaksi pemanggil (outbox, pola jobs/tenant-state.ts):
 * perubahan langganan/paket + baris provision_jobs + audit + pesan pg-boss ter-commit bersama atau tidak sama sekali.
 *
 * Satu job per environment tenant yang dilayani instance ini dengan DB ter-provision (job butuh DB). Batas kuota
 * diambil dari `plan_quotas` paket (tidak ada baris = tanpa batas). Idempotency key `bctone_tenant_config:<slug>:<env>:
 * tenant`: job aktif dengan args SAMA dipakai ulang; job aktif dengan args BERBEDA → job baru diantrekan setelah job
 * final berikutnya tidak menahan kunci (kunci dilepas dari job lama yang masih aktif tidak mungkin → dilewati, dicoba
 * oleh perubahan berikutnya; dicatat `skipped: busy`).
 */
import { and, eq, inArray } from "drizzle-orm";
import { auditLogs, environments, planQuotas, provisionJobs } from "../db/schema";
import {
  BCTONE_METRIC_ARGS,
  INSTANCE_ENVS,
  idempotencyKey,
  validateJobRequest,
  type BctonePack,
  type BridgeJobType,
  type Instance,
} from "../lib/job-contract";
import { canonicalJson } from "./chain";
import type { RequestMeta, SendFn, Tx } from "./service";

const ACTIVE = ["queued", "dispatched", "running"] as const;

export interface BctoneConfigInput {
  instance: Instance | undefined;
  allowedTypes: readonly BridgeJobType[];
  client: { id: string; slug: string };
  plan: { id: string; code: string };
  enabled: boolean;
  pack?: BctonePack | undefined;
  actorLabel: string;
  actorUserId: string | null;
  meta: RequestMeta;
  context: Record<string, unknown>;
  now: Date;
}

export type BctoneConfigOutcome =
  | { kind: "enqueued"; jobIds: string[]; reused: number; busy: number }
  | { kind: "skipped"; reason: "no_instance" | "type_not_allowed" | "no_environment" | "invalid" };

export async function bctoneLimits(tx: Tx, planId: string): Promise<Record<string, number>> {
  const rows = await tx.select({ metric: planQuotas.metric, limit: planQuotas.limitValue }).from(planQuotas).where(eq(planQuotas.planId, planId));
  const out: Record<string, number> = {};
  for (const m of BCTONE_METRIC_ARGS) {
    const r = rows.find((x) => x.metric === m);
    if (r) out[m] = r.limit;
  }
  return out;
}

export async function enqueueBctoneConfigTx(tx: Tx, send: SendFn, input: BctoneConfigInput): Promise<BctoneConfigOutcome> {
  if (!input.instance) return { kind: "skipped", reason: "no_instance" };
  if (!input.allowedTypes.includes("bctone_tenant_config")) return { kind: "skipped", reason: "type_not_allowed" };
  const instance = input.instance;
  const envs = await tx
    .select({ id: environments.id, kind: environments.kind })
    .from(environments)
    .where(and(eq(environments.clientId, input.client.id), inArray(environments.kind, [...INSTANCE_ENVS[instance]]), eq(environments.dbStatus, "provisioned")))
    .orderBy(environments.kind);
  if (envs.length === 0) return { kind: "skipped", reason: "no_environment" };

  const args: Record<string, unknown> = { plan: input.plan.code, enabled: input.enabled };
  if (input.enabled) {
    args.limits = await bctoneLimits(tx, input.plan.id);
    if (input.pack) args.pack = input.pack;
  }
  const jobIds: string[] = [];
  let reused = 0;
  let busy = 0;
  for (const e of envs) {
    const v = validateJobRequest(instance, { type: "bctone_tenant_config", slug: input.client.slug, env: e.kind, dryRun: false, args });
    if (!v.ok) return { kind: "skipped", reason: "invalid" };
    const key = idempotencyKey(v.value)!;
    const existing = (
      await tx
        .select({ id: provisionJobs.id, status: provisionJobs.status, payload: provisionJobs.payload })
        .from(provisionJobs)
        .where(eq(provisionJobs.idempotencyKey, key))
        .for("update")
        .limit(1)
    )[0];
    if (existing) {
      if ((ACTIVE as readonly string[]).includes(existing.status)) {
        if (canonicalJson((existing.payload as { args?: unknown }).args ?? null) === canonicalJson(v.value.args)) {
          jobIds.push(existing.id);
          reused++;
        } else {
          busy++;
        }
        continue;
      }
      await tx.update(provisionJobs).set({ idempotencyKey: null }).where(eq(provisionJobs.id, existing.id));
    }
    const id = (
      await tx
        .insert(provisionJobs)
        .values({
          type: "bctone_tenant_config",
          status: "queued",
          clientId: input.client.id,
          environmentId: e.id,
          env: e.kind,
          dryRun: false,
          payload: { slug: input.client.slug, args: v.value.args as Record<string, unknown> },
          actorUserId: input.actorUserId,
          actor: input.actorLabel,
          createdAt: input.now,
          idempotencyKey: key,
        })
        .returning({ id: provisionJobs.id })
    )[0]?.id;
    if (!id) throw new Error("insert provision_jobs tanpa id");
    await tx.insert(auditLogs).values({
      actorUserId: input.actorUserId,
      actor: input.actorLabel,
      action: "job.enqueue.bctone_tenant_config",
      targetType: "environment",
      targetId: e.id,
      clientId: input.client.id,
      result: "success",
      ip: input.meta.ip,
      requestId: input.meta.requestId,
      metadata: { env: e.kind, job_id: id, plan: input.plan.code, enabled: input.enabled, ...input.context },
    });
    const bossId = await send(tx, id);
    if (bossId) await tx.update(provisionJobs).set({ bossJobId: bossId }).where(eq(provisionJobs.id, id));
    jobIds.push(id);
  }
  return { kind: "enqueued", jobIds, reused, busy };
}
