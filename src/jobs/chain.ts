/**
 * Rantai job + idempotency (kontrak SaaS Fase 1 §2.1/§2.2). Satu transaksi: validasi kontrak setiap langkah →
 * dedupe per `idempotency_key` → kuota (langkah baru saja) → INSERT provision_jobs berurutan (`after_job_id` = langkah
 * sebelumnya, `chain_id` sama) → audit_logs → pesan pg-boss HANYA untuk kepala rantai (outbox, transaksi sama).
 * Langkah berikutnya di-dispatch worker (bridge.advanceChains) setelah pendahulunya `succeeded`; pendahulu
 * `failed|cancelled` → langkah ini `cancelled` dengan error_code `chain_aborted`.
 *
 * Idempotency: `idempotency_key` unik. Job lain dengan kunci sama masih AKTIF → dipakai ulang (args sama) atau
 * ditolak `duplicate` (args beda — mis. enable saat disable masih berjalan). Job final dengan kunci sama → kuncinya
 * dilepas (NULL) lalu job baru memegang kunci (riwayat tetap ada, operasi ulang tetap mungkin).
 *
 * Temuan QA (Lead 2026-10-03):
 * - F1.1: `kc_user_ensure adopt=true` hanya dari aktor ber-izin `users:manage` (superadmin) — selain itu ditolak +
 *   diaudit `adopt_forbidden` (titik sempit: semua tipe SaaS Fase 1 hanya bisa di-enqueue lewat fungsi ini).
 * - F2: aturan satu tenant-admin ditegakkan ATOMIK saat enqueue — rantai yang memuat `kc_user_set_roles
 *   cp_role=client_admin` mengambil `pg_advisory_xact_lock(hashtext('tenant-admin:'||client_id))` lalu menolak bila
 *   sudah ada client_admin invited/active atau job set_roles client_admin AKTIF untuk tenant itu (email lain).
 */
import { randomUUID } from "node:crypto";
import { and, count, countDistinct, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { isUniqueViolation, safeErrorMessage } from "../db/errors";
import { auditLogs, provisionJobs, users } from "../db/schema";
import {
  BRIDGE_JOB_TYPES,
  idempotencyKey,
  validateJobRequest,
  type BridgeJobType,
  type ContractIssue,
  type Instance,
  type JobRequest,
} from "../lib/job-contract";
import { evaluateChainQuota, type ChainQuotaCounts, type ChainQuotaViolation } from "../lib/quota";
import { can } from "../lib/roles";
import type { ChainStep } from "../lib/user-admin";
import type { Actor, RequestMeta, SendFn, Tx } from "./service";

const ACTIVE = ["queued", "dispatched", "running"] as const;

export interface ChainInput {
  instance: Instance;
  /** Allowlist tipe instance (env INFRA_JOBS_TYPES). */
  allowedTypes: readonly BridgeJobType[];
  client: { id: string; slug: string };
  steps: readonly ChainStep[];
  actor: Actor;
  meta: RequestMeta;
  audit: { action: string; targetType: string; targetId: string | null; metadata: Record<string, unknown> };
}

export type ChainFailure =
  | { reason: "invalid"; issue: ContractIssue; step: number }
  | { reason: "quota"; violation: ChainQuotaViolation }
  | { reason: "duplicate"; existingJobId: string }
  /** F1.1: adopt=true dari aktor tanpa `users:manage`. */
  | { reason: "adopt_forbidden" }
  /** F2: tenant sudah punya client_admin invited/active atau job set_roles client_admin aktif. */
  | { reason: "one_admin"; conflict: "user" | "job" }
  | { reason: "error"; message: string };

export type ChainOutcome =
  | { ok: true; chainId: string; jobIds: string[]; reused: number }
  | ({ ok: false } & ChainFailure);

/** JSON kanonik (kunci terurut) — payload jsonb dari DB tidak mempertahankan urutan kunci. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

/** Validasi semua langkah (murni). */
export function validateChain(
  instance: Instance,
  allowedTypes: readonly BridgeJobType[],
  slug: string,
  steps: readonly ChainStep[],
): { ok: true; reqs: JobRequest[] } | { ok: false; issue: ContractIssue; step: number } {
  if (steps.length === 0 || steps.length > 12) return { ok: false, issue: "args", step: 0 };
  const reqs: JobRequest[] = [];
  for (const [i, s] of steps.entries()) {
    if (!allowedTypes.includes(s.type)) return { ok: false, issue: "type_not_allowed", step: i };
    const v = validateJobRequest(instance, { type: s.type, slug, env: s.env, dryRun: false, args: s.args });
    if (!v.ok) return { ok: false, issue: v.issue, step: i };
    reqs.push(v.value);
  }
  return { ok: true, reqs };
}

/** Langkah adopt (kc_user_ensure adopt=true) di rantai — murni. */
export function chainHasAdopt(steps: readonly ChainStep[]): boolean {
  return steps.some((s) => s.type === "kc_user_ensure" && s.args.adopt === true);
}

/** Email target langkah `kc_user_set_roles cp_role=client_admin` (aturan satu admin, F2) — murni. */
export function chainAdminEmails(steps: readonly ChainStep[]): string[] {
  const out = new Set<string>();
  for (const s of steps) {
    if (s.type === "kc_user_set_roles" && s.args.cp_role === "client_admin" && typeof s.args.email === "string") out.add(s.args.email);
  }
  return [...out];
}

/**
 * F2 — di DALAM transaksi enqueue, setelah advisory lock per tenant: admin lain (users invited/active) atau job
 * `kc_user_set_roles cp_role=client_admin` aktif untuk email lain → konflik. Email target sendiri dikecualikan
 * (admin yang sama mengubah akses Odoo / aktifkan ulang; dedupe idempotency menangani permintaan ganda).
 */
async function tenantAdminConflict(tx: Tx, clientId: string, emails: readonly string[]): Promise<"user" | "job" | null> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`tenant-admin:${clientId}`}))`);
  const inList = sql.join(
    emails.map((e) => sql`${e.toLowerCase()}`),
    sql`, `,
  );
  const admin = await tx
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.clientId, clientId), eq(users.role, "client_admin"), inArray(users.status, ["invited", "active"]), or(isNull(users.email), sql`lower(${users.email}) NOT IN (${inList})`)))
    .limit(1);
  if (admin.length > 0) return "user";
  const job = await tx
    .select({ id: provisionJobs.id })
    .from(provisionJobs)
    .where(
      and(
        eq(provisionJobs.clientId, clientId),
        eq(provisionJobs.type, "kc_user_set_roles"),
        inArray(provisionJobs.status, [...ACTIVE]),
        sql`${provisionJobs.payload} -> 'args' ->> 'cp_role' = 'client_admin'`,
        sql`lower(coalesce(${provisionJobs.payload} -> 'args' ->> 'email', '')) NOT IN (${inList})`,
      ),
    )
    .limit(1);
  return job.length > 0 ? "job" : null;
}

async function chainQuotaCounts(tx: Tx, actorLabel: string, now: Date): Promise<ChainQuotaCounts> {
  const hourAgo = new Date(now.getTime() - 3600_000);
  const dayAgo = new Date(now.getTime() - 86_400_000);
  const minuteAgo = new Date(now.getTime() - 60_000);
  const one = async (where: ReturnType<typeof and>) =>
    (await tx.select({ n: count() }).from(provisionJobs).where(where))[0]?.n ?? 0;
  const types = (t: BridgeJobType[]) => inArray(provisionJobs.type, t);
  return {
    totalLastHour: await one(and(types([...BRIDGE_JOB_TYPES]), gte(provisionJobs.createdAt, hourAgo))),
    kcUserLastHour: await one(
      and(types(["kc_user_ensure", "kc_user_set_roles", "kc_user_set_enabled", "kc_user_action_email"]), gte(provisionJobs.createdAt, hourAgo)),
    ),
    kcUserDisableLastHour: await one(
      and(
        types(["kc_user_set_enabled"]),
        eq(provisionJobs.dryRun, false),
        sql`${provisionJobs.payload} -> 'args' ->> 'enabled' = 'false'`,
        gte(provisionJobs.createdAt, hourAgo),
      ),
    ),
    kcActionEmailLastHour: await one(and(types(["kc_user_action_email"]), gte(provisionJobs.createdAt, hourAgo))),
    kcRealmSyncLastDay: await one(and(types(["kc_realm_sync"]), gte(provisionJobs.createdAt, dayAgo))),
    tenantStateLastDay: await one(and(types(["tenant_suspend", "tenant_resume"]), gte(provisionJobs.createdAt, dayAgo))),
    odooUserLastHour: await one(and(types(["odoo_user_ensure"]), gte(provisionJobs.createdAt, hourAgo))),
    actorChainsLastMinute:
      (
        await tx
          .select({ n: countDistinct(sql`coalesce(${provisionJobs.chainId}, ${provisionJobs.id})`) })
          .from(provisionJobs)
          .where(and(eq(provisionJobs.actor, actorLabel), gte(provisionJobs.createdAt, minuteAgo)))
      )[0]?.n ?? 0,
  };
}

class Abort extends Error {
  constructor(readonly failure: ChainFailure) {
    super(failure.reason);
  }
}

async function auditChain(
  db: Db | Tx,
  input: ChainInput,
  result: "success" | "rejected",
  extra: Record<string, unknown>,
): Promise<void> {
  await db.insert(auditLogs).values({
    actorUserId: input.actor.userId,
    actor: `user:${input.actor.sub}`,
    action: input.audit.action,
    targetType: input.audit.targetType,
    targetId: input.audit.targetId,
    clientId: input.client.id,
    result,
    ip: input.meta.ip,
    requestId: input.meta.requestId,
    metadata: { ...input.audit.metadata, steps: input.steps.map((s) => `${s.type}@${s.env}`), ...extra },
  });
}

/** Audit penolakan di luar transaksi utama (yang di-rollback). Gagal audit tidak menggagalkan respons. */
export async function auditRejectedChain(db: Db, input: ChainInput, extra: Record<string, unknown>): Promise<void> {
  try {
    await auditChain(db, input, "rejected", extra);
  } catch {
    // diabaikan
  }
}

async function insertChain(db: Db, send: SendFn, input: ChainInput, reqs: JobRequest[], now: Date) {
  const actorLabel = `user:${input.actor.sub}`;
  return db.transaction(async (tx) => {
    const chainId = randomUUID();
    // 0) F2: kunci per tenant SEBELUM dedupe/insert — enqueue paralel untuk tenant yang sama berurutan di sini.
    const adminEmails = chainAdminEmails(input.steps);
    if (adminEmails.length > 0) {
      const conflict = await tenantAdminConflict(tx, input.client.id, adminEmails);
      if (conflict) throw new Abort({ reason: "one_admin", conflict });
    }
    // 1) Dedupe dulu (FOR UPDATE), kuota hanya untuk langkah baru.
    type Plan = { req: JobRequest; key: string | null; reuse: string | null };
    const plans: Plan[] = [];
    for (const req of reqs) {
      const key = idempotencyKey(req);
      let reuse: string | null = null;
      if (key) {
        const existing = (
          await tx
            .select({ id: provisionJobs.id, status: provisionJobs.status, payload: provisionJobs.payload, env: provisionJobs.env })
            .from(provisionJobs)
            .where(eq(provisionJobs.idempotencyKey, key))
            .for("update")
            .limit(1)
        )[0];
        if (existing) {
          if ((ACTIVE as readonly string[]).includes(existing.status)) {
            const same =
              canonicalJson((existing.payload as { args?: unknown }).args ?? null) === canonicalJson(req.args) && existing.env === req.env;
            if (!same) throw new Abort({ reason: "duplicate", existingJobId: existing.id });
            reuse = existing.id;
          } else {
            // Job final: lepas kunci agar job baru bisa memegangnya (riwayat tetap ada).
            await tx.update(provisionJobs).set({ idempotencyKey: null }).where(eq(provisionJobs.id, existing.id));
          }
        }
      }
      plans.push({ req, key, reuse });
    }
    const fresh = plans.filter((p) => p.reuse === null);
    const violation = evaluateChainQuota(
      await chainQuotaCounts(tx, actorLabel, now),
      fresh.map((p) => ({ type: p.req.type, dryRun: p.req.dryRun, args: p.req.args as Record<string, unknown> })),
    );
    if (violation) throw new Abort({ reason: "quota", violation });

    // 2) INSERT berurutan.
    const ids: string[] = [];
    let prev: string | null = null;
    let headId: string | null = null;
    for (const p of plans) {
      if (p.reuse) {
        ids.push(p.reuse);
        prev = p.reuse;
        continue;
      }
      const inserted: { id: string }[] = await tx
        .insert(provisionJobs)
        .values({
          type: p.req.type,
          status: "queued",
          clientId: input.client.id,
          environmentId: null,
          env: p.req.env,
          dryRun: false,
          payload: { slug: p.req.slug, args: p.req.args as Record<string, unknown> },
          actorUserId: input.actor.userId,
          actor: actorLabel,
          createdAt: now,
          idempotencyKey: p.key,
          afterJobId: prev,
          chainId,
        })
        .returning({ id: provisionJobs.id });
      const id = inserted[0]?.id;
      if (!id) throw new Error("insert provision_jobs tanpa id");
      if (prev === null) headId = id;
      ids.push(id);
      prev = id;
    }

    await auditChain(tx, input, "success", {
      chain_id: chainId,
      job_ids: ids,
      reused: plans.length - fresh.length,
    });

    // 3) Outbox: hanya kepala rantai yang baru (langkah lain menunggu pendahulu → advanceChains).
    if (headId) {
      const bossId = await send(tx, headId);
      if (bossId) await tx.update(provisionJobs).set({ bossJobId: bossId }).where(eq(provisionJobs.id, headId));
    }
    return { chainId, jobIds: ids, reused: plans.length - fresh.length };
  });
}

export async function enqueueChain(db: Db, send: SendFn, input: ChainInput, now = new Date()): Promise<ChainOutcome> {
  // F1.1: adopt hanya superadmin — dicek sebelum validasi lain, ditolak + diaudit.
  if (chainHasAdopt(input.steps) && !can(input.actor.roles, "users:manage")) {
    await auditRejectedChain(db, input, { reason: "adopt_forbidden" });
    return { ok: false, reason: "adopt_forbidden" };
  }
  const v = validateChain(input.instance, input.allowedTypes, input.client.slug, input.steps);
  if (!v.ok) {
    await auditRejectedChain(db, input, { reason: "invalid", issue: v.issue, step: v.step });
    return { ok: false, reason: "invalid", issue: v.issue, step: v.step };
  }
  // Satu ulangan: permintaan paralel dengan kunci sama → unique violation → putaran kedua melihat job yang sudah
  // ter-commit dan memakainya ulang (atau menolak duplicate).
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await insertChain(db, send, input, v.reqs, now);
      return { ok: true, ...r };
    } catch (err) {
      if (err instanceof Abort) {
        await auditRejectedChain(db, input, {
          reason: err.failure.reason,
          ...("violation" in err.failure ? { violation: err.failure.violation } : {}),
          ...("existingJobId" in err.failure ? { existing_job_id: err.failure.existingJobId } : {}),
          ...("conflict" in err.failure ? { conflict: err.failure.conflict } : {}),
        });
        return { ok: false, ...err.failure };
      }
      if (isUniqueViolation(err, "provision_jobs_idempotency_key_uq") && attempt === 0) continue;
      return { ok: false, reason: "error", message: safeErrorMessage(err) };
    }
  }
  return { ok: false, reason: "error", message: "idempotency retry habis" };
}
