/**
 * Layanan Domains (W5, ADR 0018 D1): CRUD data domain per tenant (superadmin, `domains:manage`). Setiap mutasi: izin
 * (dicek ulang di sini, di bawah requirePermission Server Action) → satu transaksi (baris dikunci) → audit_logs di
 * transaksi yang sama; penolakan diaudit `result=rejected`. Status awal `pending_dns`; token verifikasi acak dibuat
 * server. Tidak ada job/aksi DNS (verifikasi otomatis `dns_verify` = Fase 2).
 */
import { randomBytes } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { isUniqueViolation, safeErrorMessage } from "../db/errors";
import { auditLogs, clients, domains, environments, users } from "../db/schema";
import { envLinkAllowed, type DomainPurpose } from "../lib/domains";
import type { ActionResultCode } from "../lib/job-list-params";
import { can } from "../lib/roles";
import type { Actor, RequestMeta, Tx } from "./service";

export interface DomainServiceInput {
  actor: Actor;
  meta: RequestMeta;
}

export type DomainFailure =
  | { reason: "forbidden" }
  | { reason: "not_found" }
  | { reason: "tenant_inactive" }
  | { reason: "exists" }
  | { reason: "env_mismatch" }
  | { reason: "confirm" }
  | { reason: "error"; message: string };

export type DomainOutcome = { ok: true; id: string; slug: string } | ({ ok: false; slug?: string } & DomainFailure);

class Abort extends Error {
  constructor(readonly failure: DomainFailure) {
    super(failure.reason);
  }
}

/** Token verifikasi (`_platform-verify.<fqdn>` Fase 2): 32 byte acak base64url, tidak pernah dari input. */
export function newVerificationToken(): string {
  return randomBytes(32).toString("base64url");
}

async function actorDisabled(db: Db, actor: Actor): Promise<boolean> {
  if (!actor.userId) return false;
  const row = (await db.select({ status: users.status }).from(users).where(eq(users.id, actor.userId)).limit(1))[0];
  return row?.status === "disabled";
}

async function audit(db: Db | Tx, input: DomainServiceInput, v: { action: string; targetId: string | null; clientId: string | null; result: string; metadata: Record<string, unknown> }) {
  await db.insert(auditLogs).values({
    actorUserId: input.actor.userId,
    actor: `user:${input.actor.sub}`,
    action: v.action,
    targetType: "domain",
    targetId: v.targetId,
    clientId: v.clientId,
    result: v.result,
    ip: input.meta.ip,
    requestId: input.meta.requestId,
    metadata: v.metadata,
  });
}

/** Kerangka: izin → transaksi → penolakan diaudit di luar transaksi (yang di-rollback). */
async function run(
  db: Db,
  input: DomainServiceInput,
  t: { action: string; targetId: string | null; clientId: string | null; md: Record<string, unknown> },
  body: (tx: Tx, t: { clientId: string | null; slug: string | null }) => Promise<{ id: string; slug: string }>,
): Promise<DomainOutcome> {
  const ctx = { clientId: t.clientId, slug: null as string | null };
  const reject = async (failure: DomainFailure): Promise<DomainOutcome> => {
    try {
      await audit(db, input, { action: t.action, targetId: t.targetId, clientId: ctx.clientId, result: "rejected", metadata: { ...t.md, reason: failure.reason } });
    } catch {
      // diabaikan
    }
    return { ok: false, ...failure, ...(ctx.slug ? { slug: ctx.slug } : {}) };
  };
  if (!can(input.actor.roles, "domains:manage") || (await actorDisabled(db, input.actor))) return reject({ reason: "forbidden" });
  try {
    const r = await db.transaction((tx) => body(tx, ctx));
    return { ok: true, ...r };
  } catch (err) {
    if (err instanceof Abort) return reject(err.failure);
    if (isUniqueViolation(err, "domains_fqdn_uq")) return reject({ reason: "exists" });
    return { ok: false, reason: "error", message: safeErrorMessage(err) };
  }
}

async function lockTenant(tx: Tx, clientId: string) {
  return (
    await tx
      .select({ id: clients.id, slug: clients.slug, isPlatform: clients.isPlatform, status: clients.status, terminatedAt: clients.terminatedAt })
      .from(clients)
      .where(eq(clients.id, clientId))
      .for("update")
      .limit(1)
  )[0];
}

async function checkEnv(tx: Tx, environmentId: string | undefined, purpose: DomainPurpose, clientId: string): Promise<string | null> {
  if (!environmentId) return null;
  const env = (await tx.select({ id: environments.id, clientId: environments.clientId }).from(environments).where(eq(environments.id, environmentId)).limit(1))[0];
  // Environment tidak ada / milik tenant lain / purpose bukan odoo|web → env_mismatch (id dari form tidak dipercaya).
  if (!env || !envLinkAllowed(purpose, env, clientId)) throw new Abort({ reason: "env_mismatch" });
  return env.id;
}

export async function createDomain(
  db: Db,
  input: DomainServiceInput,
  p: { clientId: string; fqdn: string; purpose: DomainPurpose; environmentId?: string | undefined; dkimTxt?: string | undefined },
): Promise<DomainOutcome> {
  return run(db, input, { action: "domain.create", targetId: null, clientId: null, md: { fqdn: p.fqdn, purpose: p.purpose } }, async (tx, ctx) => {
    const c = await lockTenant(tx, p.clientId);
    if (!c) throw new Abort({ reason: "not_found" });
    ctx.clientId = c.id;
    ctx.slug = c.slug;
    if (c.isPlatform || c.status === "terminated" || c.terminatedAt !== null) throw new Abort({ reason: "tenant_inactive" });
    const envId = await checkEnv(tx, p.environmentId, p.purpose, c.id);
    const row = (
      await tx
        .insert(domains)
        .values({
          clientId: c.id,
          fqdn: p.fqdn,
          purpose: p.purpose,
          environmentId: envId,
          dkimTxt: p.purpose === "mail" ? (p.dkimTxt ?? null) : null,
          status: "pending_dns",
          verificationToken: newVerificationToken(),
        })
        .onConflictDoNothing({ target: domains.fqdn })
        .returning({ id: domains.id })
    )[0];
    if (!row) throw new Abort({ reason: "exists" });
    await audit(tx, input, {
      action: "domain.create",
      targetId: row.id,
      clientId: c.id,
      result: "success",
      metadata: { fqdn: p.fqdn, purpose: p.purpose, environment_id: envId, has_dkim: p.purpose === "mail" && !!p.dkimTxt },
    });
    return { id: row.id, slug: c.slug };
  });
}

async function lockDomain(tx: Tx, domainId: string) {
  return (
    await tx
      .select({ id: domains.id, clientId: domains.clientId, fqdn: domains.fqdn, purpose: domains.purpose, environmentId: domains.environmentId, dkimTxt: domains.dkimTxt })
      .from(domains)
      .where(eq(domains.id, domainId))
      .for("update")
      .limit(1)
  )[0];
}

export async function updateDomain(
  db: Db,
  input: DomainServiceInput,
  p: { domainId: string; purpose: DomainPurpose; environmentId?: string | undefined; dkimTxt?: string | undefined },
): Promise<DomainOutcome> {
  return run(db, input, { action: "domain.update", targetId: p.domainId, clientId: null, md: { purpose: p.purpose } }, async (tx, ctx) => {
    const d = await lockDomain(tx, p.domainId);
    if (!d) throw new Abort({ reason: "not_found" });
    ctx.clientId = d.clientId;
    const c = await lockTenant(tx, d.clientId);
    if (!c) throw new Abort({ reason: "not_found" });
    ctx.slug = c.slug;
    if (c.status === "terminated" || c.terminatedAt !== null) throw new Abort({ reason: "tenant_inactive" });
    const envId = await checkEnv(tx, p.environmentId, p.purpose, d.clientId);
    const dkimTxt = p.purpose === "mail" ? (p.dkimTxt ?? null) : null;
    await tx.update(domains).set({ purpose: p.purpose, environmentId: envId, dkimTxt, updatedAt: sql`now()` }).where(eq(domains.id, d.id));
    await audit(tx, input, {
      action: "domain.update",
      targetId: d.id,
      clientId: d.clientId,
      result: "success",
      metadata: {
        fqdn: d.fqdn,
        from: { purpose: d.purpose, environment_id: d.environmentId, has_dkim: d.dkimTxt !== null },
        to: { purpose: p.purpose, environment_id: envId, has_dkim: dkimTxt !== null },
      },
    });
    return { id: d.id, slug: c.slug };
  });
}

export async function deleteDomain(db: Db, input: DomainServiceInput, p: { domainId: string; confirm: string }): Promise<DomainOutcome> {
  return run(db, input, { action: "domain.delete", targetId: p.domainId, clientId: null, md: {} }, async (tx, ctx) => {
    const d = await lockDomain(tx, p.domainId);
    if (!d) throw new Abort({ reason: "not_found" });
    ctx.clientId = d.clientId;
    ctx.slug = (await tx.select({ slug: clients.slug }).from(clients).where(eq(clients.id, d.clientId)).limit(1))[0]?.slug ?? null;
    if (p.confirm !== d.fqdn) throw new Abort({ reason: "confirm" });
    await tx.delete(domains).where(eq(domains.id, d.id));
    await audit(tx, input, { action: "domain.delete", targetId: d.id, clientId: d.clientId, result: "success", metadata: { fqdn: d.fqdn, purpose: d.purpose } });
    return { id: d.id, slug: ctx.slug ?? "" };
  });
}

/** Kode `?r=` (whitelist ACTION_RESULT_CODES) — murni. */
export function domainOutcomeCode(o: DomainOutcome, kind: "create" | "update" | "delete"): ActionResultCode {
  if (o.ok) return kind === "create" ? "created" : kind === "update" ? "updated" : "deleted";
  return o.reason;
}
