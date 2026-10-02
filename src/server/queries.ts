import "server-only";
import { and, desc, eq, inArray, type SQL } from "drizzle-orm";
import { getDb } from "@/db";
import { auditLogs, clients, environments, provisionJobs, tenantUserAccess, users } from "@/db/schema";
import type { JobListParams } from "@/lib/job-list-params";

/** Semua query terparametrisasi Drizzle; input sudah lolos Zod (uuid/slug/enum) sebelum sampai sini. */

export async function getClientBySlug(slug: string) {
  const rows = await getDb()
    .select({ id: clients.id, slug: clients.slug, name: clients.name, createdAt: clients.createdAt, terminatedAt: clients.terminatedAt })
    .from(clients)
    .where(eq(clients.slug, slug))
    .limit(1);
  return rows[0] ?? null;
}

export async function listEnvironmentsForClient(clientId: string) {
  return getDb()
    .select({
      id: environments.id,
      kind: environments.kind,
      dbName: environments.dbName,
      url: environments.url,
      host: environments.host,
      dbStatus: environments.dbStatus,
      routeStatus: environments.routeStatus,
      ssoStatus: environments.ssoStatus,
      tenantCheck: environments.tenantCheck,
    })
    .from(environments)
    .where(eq(environments.clientId, clientId))
    .orderBy(environments.kind);
}

export async function getEnvironment(id: string) {
  const rows = await getDb()
    .select({
      id: environments.id,
      kind: environments.kind,
      odooInstance: environments.odooInstance,
      dbName: environments.dbName,
      url: environments.url,
      host: environments.host,
      dbStatus: environments.dbStatus,
      routeStatus: environments.routeStatus,
      ssoStatus: environments.ssoStatus,
      ssoClientId: environments.ssoClientId,
      ssoProviderId: environments.ssoProviderId,
      lastJobId: environments.lastJobId,
      updatedAt: environments.updatedAt,
      clientId: clients.id,
      slug: clients.slug,
      clientName: clients.name,
    })
    .from(environments)
    .innerJoin(clients, eq(clients.id, environments.clientId))
    .where(eq(environments.id, id))
    .limit(1);
  return rows[0] ?? null;
}

export async function listTenantUsers(environmentId: string) {
  return getDb()
    .select({
      id: tenantUserAccess.id,
      email: tenantUserAccess.email,
      odooLogin: tenantUserAccess.odooLogin,
      isTenantAdmin: tenantUserAccess.isTenantAdmin,
      status: tenantUserAccess.status,
      kcUserId: tenantUserAccess.kcUserId,
      odooUserId: tenantUserAccess.odooUserId,
      lastJobId: tenantUserAccess.lastJobId,
      updatedAt: tenantUserAccess.updatedAt,
    })
    .from(tenantUserAccess)
    .where(eq(tenantUserAccess.environmentId, environmentId))
    .orderBy(tenantUserAccess.email);
}

const jobColumns = {
  id: provisionJobs.id,
  type: provisionJobs.type,
  status: provisionJobs.status,
  env: provisionJobs.env,
  dryRun: provisionJobs.dryRun,
  errorCode: provisionJobs.errorCode,
  exitCode: provisionJobs.exitCode,
  actor: provisionJobs.actor,
  createdAt: provisionJobs.createdAt,
  finishedAt: provisionJobs.finishedAt,
  environmentId: provisionJobs.environmentId,
  clientSlug: clients.slug,
};

export const JOB_PAGE_SIZE = 50;

export async function listJobs(params: JobListParams & { environmentId?: string }, limit = JOB_PAGE_SIZE) {
  const conds: SQL[] = [];
  if (params.environmentId) conds.push(eq(provisionJobs.environmentId, params.environmentId));
  if (params.client) conds.push(eq(clients.slug, params.client));
  if (params.status) conds.push(eq(provisionJobs.status, params.status));
  if (params.type) conds.push(eq(provisionJobs.type, params.type));
  return getDb()
    .select(jobColumns)
    .from(provisionJobs)
    .leftJoin(clients, eq(clients.id, provisionJobs.clientId))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(provisionJobs.createdAt))
    .limit(limit)
    .offset((params.page - 1) * limit);
}

export async function getJob(id: string) {
  const rows = await getDb()
    .select({
      ...jobColumns,
      payload: provisionJobs.payload,
      result: provisionJobs.result,
      log: provisionJobs.log,
      error: provisionJobs.error,
      parentJobId: provisionJobs.parentJobId,
      dispatchedAt: provisionJobs.dispatchedAt,
      startedAt: provisionJobs.startedAt,
      deadlineAt: provisionJobs.deadlineAt,
      attempts: provisionJobs.attempts,
    })
    .from(provisionJobs)
    .leftJoin(clients, eq(clients.id, provisionJobs.clientId))
    .where(eq(provisionJobs.id, id))
    .limit(1);
  return rows[0] ?? null;
}

export async function listAuditForEnvironment(environmentId: string, limit = 30) {
  return getDb()
    .select({
      id: auditLogs.id,
      occurredAt: auditLogs.occurredAt,
      actor: auditLogs.actor,
      actorEmail: users.email,
      action: auditLogs.action,
      result: auditLogs.result,
      metadata: auditLogs.metadata,
    })
    .from(auditLogs)
    .leftJoin(users, eq(users.id, auditLogs.actorUserId))
    .where(and(eq(auditLogs.targetType, "environment"), eq(auditLogs.targetId, environmentId)))
    .orderBy(desc(auditLogs.occurredAt))
    .limit(limit);
}

export async function countActiveJobs(environmentId: string) {
  const rows = await getDb()
    .select({ type: provisionJobs.type })
    .from(provisionJobs)
    .where(and(eq(provisionJobs.environmentId, environmentId), inArray(provisionJobs.status, ["queued", "dispatched", "running"])));
  return new Set(rows.map((r) => r.type));
}
