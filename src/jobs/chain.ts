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
 *
 * Fase 1 W5 (onboarding tenant): rantai boleh memuat tipe lama yang terikat environment (`CHAIN_ENV_TYPES`:
 * odoo_db_provision → odoo_route → odoo_sso_provision). `environment_id` langkah itu diturunkan SERVER dari
 * (client, env) — tidak pernah dari input — sehingga langkah ikut partial unique index `provision_jobs_one_active_uq`
 * (satu job aktif per environment+type). Pengganti idempotency_key untuk tipe lama = indeks itu: job aktif
 * (environment, type) dengan args sama dipakai ulang, args beda → `duplicate`; tabrakan paralel (unique violation)
 * → satu ulangan lalu `duplicate`. Aksi berisiko (`requiresAdmin`) wajib `jobs:odoo_admin`; tipe lama lain
 * (sso_disable, sso_user) tidak boleh masuk rantai. `prelude` = langkah DB tambahan di transaksi yang sama (mis.
 * INSERT clients/environments onboarding, kunci status tenant) — semua atau tidak sama sekali.
 */
import { randomUUID } from "node:crypto";
import { and, count, countDistinct, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { isUniqueViolation, safeErrorMessage } from "../db/errors";
import { auditLogs, environments, provisionJobs, users } from "../db/schema";
import {
  BRIDGE_JOB_TYPES,
  isSaasP1JobType,
  checkSsoHosts,
  defaultHost,
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
import { requiresAdmin, type Actor, type RequestMeta, type SendFn, type Tx } from "./service";

const ACTIVE = ["queued", "dispatched", "running"] as const;

/** Batas langkah satu rantai (onboarding prod+demo = 14 langkah). */
export const MAX_CHAIN_STEPS = 20;

/**
 * Tipe lama (plan 05) yang boleh masuk rantai — terikat environment (environment_id diisi server). Tipe lama lain
 * (`odoo_sso_disable`, `odoo_sso_user`) hanya lewat halaman environment (enqueueBridgeJob, bookkeeping
 * tenant_user_access).
 */
export const CHAIN_ENV_TYPES = ["odoo_db_provision", "odoo_route", "odoo_sso_provision"] as const satisfies readonly BridgeJobType[];

export function isChainEnvType(t: string): t is (typeof CHAIN_ENV_TYPES)[number] {
  return (CHAIN_ENV_TYPES as readonly string[]).includes(t);
}

export interface ChainInput {
  instance: Instance;
  /** Allowlist tipe instance (env INFRA_JOBS_TYPES). */
  allowedTypes: readonly BridgeJobType[];
  /** `isNew` = baris clients dibuat oleh `prelude` (audit penolakan tanpa client_id — barisnya di-rollback). */
  client: { id: string; slug: string; isNew?: boolean };
  steps: readonly ChainStep[];
  actor: Actor;
  meta: RequestMeta;
  audit: { action: string; targetType: string; targetId: string | null; metadata: Record<string, unknown> };
  /** Langkah DB di transaksi yang sama SEBELUM dedupe/insert; lempar `ChainAbort` untuk menolak. */
  prelude?: (tx: Tx) => Promise<void>;
  /** "Ulangi dari langkah gagal": parent_job_id kepala rantai baru = job yang diulang. */
  retryOf?: string | null;
}

export type ChainFailure =
  | { reason: "invalid"; issue: ContractIssue; step: number }
  | { reason: "quota"; violation: ChainQuotaViolation }
  | { reason: "duplicate"; existingJobId: string }
  /** F1.1: adopt=true dari aktor tanpa `users:manage`. */
  | { reason: "adopt_forbidden" }
  /** F2: tenant sudah punya client_admin invited/active atau job set_roles client_admin aktif. */
  | { reason: "one_admin"; conflict: "user" | "job" }
  /** Langkah tipe lama berisiko (requiresAdmin) tanpa jobs:odoo_admin, atau tipe lama tanpa jobs:odoo. */
  | { reason: "forbidden" }
  /** Prelude: slug/DB/host sudah dipakai. */
  | { reason: "exists" }
  /**
   * Prasyarat rantai: environment (client, env) tidak ada; host SSO tidak ada di route (rantai/DB); status tenant
   * sedang berubah (suspend/resume aktif); rencana kc_realm_sync belum ada/berblokir.
   */
  | { reason: "precondition"; detail: ChainPreconditionDetail; step?: number }
  | { reason: "error"; message: string };

export type ChainPreconditionDetail =
  | "env_missing"
  | "host_not_in_route"
  | "host_taken"
  | "state_busy"
  | "plan_required"
  | "no_env"
  /** Onboarding: plan langganan tidak ada/tidak aktif/bukan layanan odoo (createSubscriptionTx di prelude). */
  | "plan_inactive";

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
  if (steps.length === 0 || steps.length > MAX_CHAIN_STEPS) return { ok: false, issue: "args", step: 0 };
  const reqs: JobRequest[] = [];
  for (const [i, s] of steps.entries()) {
    if (!allowedTypes.includes(s.type)) return { ok: false, issue: "type_not_allowed", step: i };
    // Tipe lama di luar CHAIN_ENV_TYPES tidak pernah lewat rantai (bookkeeping tenant_user_access ada di service.ts).
    if (!isSaasP1JobType(s.type) && !isChainEnvType(s.type)) return { ok: false, issue: "type_not_allowed", step: i };
    const v = validateJobRequest(instance, { type: s.type, slug, env: s.env, dryRun: s.dryRun ?? false, args: s.args });
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
 * Host route yang AKAN aktif per env bila langkah odoo_route (remove=false) di rantai ini sebelum langkah `upTo` sukses
 * (host = args.host atau host default skrip). Dipakai cek prasyarat odoo_sso_provision di rantai — murni.
 */
export function chainRouteHosts(reqs: readonly JobRequest[], upTo: number): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of reqs.slice(0, upTo)) {
    if (r.type !== "odoo_route") continue;
    const a = r.args as { host?: string; remove: boolean };
    if (a.remove) {
      out.delete(r.env);
      continue;
    }
    const h = a.host ?? defaultHost(r.slug, r.env);
    if (h) out.set(r.env, h);
  }
  return out;
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
    dbProvisionLastDay: await one(
      and(types(["odoo_db_provision"]), eq(provisionJobs.dryRun, false), gte(provisionJobs.createdAt, dayAgo)),
    ),
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

/** Dilempar `prelude` untuk menolak rantai (transaksi di-rollback, penolakan diaudit). */
export { Abort as ChainAbort };

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
    // Baris clients baru (prelude) ikut di-rollback saat ditolak → audit penolakan tanpa FK client.
    clientId: result === "rejected" && input.client.isNew ? null : input.client.id,
    result,
    ip: input.meta.ip,
    requestId: input.meta.requestId,
    metadata: {
      ...input.audit.metadata,
      steps: input.steps.map((s) => `${s.type}@${s.env}${s.dryRun ? ":dry" : ""}`),
      ...(input.retryOf ? { retry_of: input.retryOf } : {}),
      ...extra,
    },
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
    if (input.prelude) await input.prelude(tx);
    // 0) F2: kunci per tenant SEBELUM dedupe/insert — enqueue paralel untuk tenant yang sama berurutan di sini.
    const adminEmails = chainAdminEmails(input.steps);
    if (adminEmails.length > 0) {
      const conflict = await tenantAdminConflict(tx, input.client.id, adminEmails);
      if (conflict) throw new Abort({ reason: "one_admin", conflict });
    }
    // 0b) Langkah tipe lama: environment_id dari (client, env) + prasyarat host SSO (cermin check_hosts dispatcher).
    const envIds: (string | null)[] = [];
    for (const [i, req] of reqs.entries()) {
      if (!isChainEnvType(req.type)) {
        envIds.push(null);
        continue;
      }
      const envRow = (
        await tx
          .select({ id: environments.id, host: environments.host, routeStatus: environments.routeStatus })
          .from(environments)
          .where(and(eq(environments.clientId, input.client.id), eq(environments.kind, req.env)))
          .limit(1)
      )[0];
      if (!envRow) throw new Abort({ reason: "precondition", detail: "env_missing", step: i });
      if (req.type === "odoo_sso_provision") {
        const planned = chainRouteHosts(reqs, i).get(req.env);
        const routeHosts = [
          ...(planned ? [planned] : []),
          ...(envRow.routeStatus === "active" && envRow.host ? [envRow.host] : []),
        ];
        if (!checkSsoHosts(req, routeHosts).ok) throw new Abort({ reason: "precondition", detail: "host_not_in_route", step: i });
      }
      envIds.push(envRow.id);
    }
    // 1) Dedupe dulu (FOR UPDATE), kuota hanya untuk langkah baru.
    type Plan = { req: JobRequest; key: string | null; reuse: string | null; environmentId: string | null };
    const plans: Plan[] = [];
    for (const [i, req] of reqs.entries()) {
      const key = idempotencyKey(req);
      const environmentId = envIds[i] ?? null;
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
      } else if (environmentId) {
        // Tipe lama: "kunci" = satu job aktif per (environment, type) — provision_jobs_one_active_uq.
        const existing = (
          await tx
            .select({ id: provisionJobs.id, payload: provisionJobs.payload, dryRun: provisionJobs.dryRun })
            .from(provisionJobs)
            .where(
              and(
                eq(provisionJobs.environmentId, environmentId),
                eq(provisionJobs.type, req.type),
                inArray(provisionJobs.status, [...ACTIVE]),
              ),
            )
            .for("update")
            .limit(1)
        )[0];
        if (existing) {
          const same =
            !existing.dryRun && !req.dryRun && canonicalJson((existing.payload as { args?: unknown }).args ?? null) === canonicalJson(req.args);
          if (!same) throw new Abort({ reason: "duplicate", existingJobId: existing.id });
          reuse = existing.id;
        }
      }
      plans.push({ req, key, reuse, environmentId });
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
          environmentId: p.environmentId,
          env: p.req.env,
          dryRun: p.req.dryRun,
          payload: { slug: p.req.slug, args: p.req.args as Record<string, unknown> },
          actorUserId: input.actor.userId,
          actor: actorLabel,
          createdAt: now,
          idempotencyKey: p.key,
          afterJobId: prev,
          chainId,
          parentJobId: prev === null && input.retryOf ? input.retryOf : null,
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
  // Tipe lama di rantai: izin sama dengan halaman environment (jobs:odoo; aksi berisiko jobs:odoo_admin).
  const legacy = v.reqs.filter((r) => isChainEnvType(r.type));
  if (
    (legacy.length > 0 && !can(input.actor.roles, "jobs:odoo")) ||
    legacy.some((r) => requiresAdmin(r.type, r.args) && !can(input.actor.roles, "jobs:odoo_admin"))
  ) {
    await auditRejectedChain(db, input, { reason: "forbidden" });
    return { ok: false, reason: "forbidden" };
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
          ...("detail" in err.failure ? { detail: err.failure.detail } : {}),
          ...("step" in err.failure && err.failure.step !== undefined ? { step: err.failure.step } : {}),
        });
        return { ok: false, ...err.failure };
      }
      if (isUniqueViolation(err, "provision_jobs_idempotency_key_uq") && attempt === 0) continue;
      // Tipe lama: job aktif (environment, type) paralel ter-commit di antara SELECT dan INSERT → putaran kedua
      // memakai ulang (args sama) atau menolak duplicate.
      if (isUniqueViolation(err, "provision_jobs_one_active_uq")) {
        if (attempt === 0) continue;
        await auditRejectedChain(db, input, { reason: "duplicate" });
        return { ok: false, reason: "duplicate", existingJobId: "" };
      }
      return { ok: false, reason: "error", message: safeErrorMessage(err) };
    }
  }
  return { ok: false, reason: "error", message: "idempotency retry habis" };
}
