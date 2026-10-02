import "server-only";
import { and, asc, desc, eq, inArray, isNotNull, isNull, type SQL } from "drizzle-orm";
import { getDb } from "@/db";
import { clients, environments, provisionJobs, tenantUserAccess, users } from "@/db/schema";
import { SAAS_P1_JOB_TYPES } from "@/lib/job-contract";
import { orderChain, type ChainStepRow } from "@/lib/user-admin";

/** Query halaman Users — terparametrisasi Drizzle; filter sudah lolos whitelist (uuid/slug) sebelum sampai sini. */

export async function listTenants() {
  return getDb()
    .select({ id: clients.id, slug: clients.slug, name: clients.name, isPlatform: clients.isPlatform, terminatedAt: clients.terminatedAt })
    .from(clients)
    .orderBy(desc(clients.isPlatform), asc(clients.slug));
}

/** `tenantId` = filter tenant; `"none"` = baris tanpa tenant (login lama superadmin/ops); null = semua. */
export async function listUsers(tenantId: string | "none" | null) {
  const where: SQL | undefined = tenantId === "none" ? isNull(users.clientId) : tenantId ? eq(users.clientId, tenantId) : undefined;
  return getDb()
    .select({
      id: users.id,
      email: users.email,
      displayName: users.displayName,
      role: users.role,
      status: users.status,
      clientId: users.clientId,
      slug: clients.slug,
      isPlatform: clients.isPlatform,
      lastLoginAt: users.lastLoginAt,
      disabledAt: users.disabledAt,
      createdAt: users.createdAt,
    })
    .from(users)
    .leftJoin(clients, eq(clients.id, users.clientId))
    .where(where)
    .orderBy(asc(clients.slug), asc(users.email))
    .limit(500);
}

export async function listEnvsByClient(clientIds: string[]) {
  if (clientIds.length === 0) return [];
  return getDb()
    .select({ environmentId: environments.id, clientId: environments.clientId, kind: environments.kind, dbStatus: environments.dbStatus })
    .from(environments)
    .where(inArray(environments.clientId, clientIds))
    .orderBy(asc(environments.kind));
}

export async function listAccessByEnvs(envIds: string[]) {
  if (envIds.length === 0) return [];
  return getDb()
    .select({
      environmentId: tenantUserAccess.environmentId,
      email: tenantUserAccess.email,
      status: tenantUserAccess.status,
      isTenantAdmin: tenantUserAccess.isTenantAdmin,
    })
    .from(tenantUserAccess)
    .where(inArray(tenantUserAccess.environmentId, envIds));
}

/** Rantai job identitas terbaru (status per langkah, chain_id). */
export async function listRecentChains(tenantId: string | null, limitJobs = 200) {
  const conds: SQL[] = [isNotNull(provisionJobs.chainId), inArray(provisionJobs.type, [...SAAS_P1_JOB_TYPES])];
  if (tenantId) conds.push(eq(provisionJobs.clientId, tenantId));
  const rows = await getDb()
    .select({
      id: provisionJobs.id,
      chainId: provisionJobs.chainId,
      type: provisionJobs.type,
      env: provisionJobs.env,
      status: provisionJobs.status,
      errorCode: provisionJobs.errorCode,
      afterJobId: provisionJobs.afterJobId,
      createdAt: provisionJobs.createdAt,
      payload: provisionJobs.payload,
      actor: provisionJobs.actor,
      slug: clients.slug,
    })
    .from(provisionJobs)
    .leftJoin(clients, eq(clients.id, provisionJobs.clientId))
    .where(and(...conds))
    .orderBy(desc(provisionJobs.createdAt))
    .limit(limitJobs);
  const chains = new Map<string, { chainId: string; createdAt: Date; actor: string; steps: ChainStepRow[] }>();
  for (const r of rows) {
    const cid = r.chainId as string;
    const args = ((r.payload as { args?: Record<string, unknown> }).args ?? {}) as Record<string, unknown>;
    const step: ChainStepRow = {
      id: r.id,
      type: r.type,
      env: r.env,
      status: r.status,
      errorCode: r.errorCode,
      afterJobId: r.afterJobId,
      createdAt: r.createdAt,
      email: typeof args.email === "string" ? args.email : null,
      slug: r.slug,
    };
    const c = chains.get(cid);
    if (c) c.steps.push(step);
    else chains.set(cid, { chainId: cid, createdAt: r.createdAt, actor: r.actor, steps: [step] });
  }
  return [...chains.values()].slice(0, 25).map((c) => ({ ...c, steps: orderChain(c.steps) }));
}
