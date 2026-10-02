"use server";

/**
 * Data master minimal untuk plan 05 (backfill tenant & tenant uji tanpa SQL manual): buat client dan
 * environment. Hanya superadmin (`clients:manage`). Kolom status environment TIDAK diisi dari form —
 * default `absent/none`, diperbarui dari hasil job.
 */
import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { getDb } from "@/db";
import { isUniqueViolation, safeErrorMessage } from "@/db/errors";
import { auditLogs, clients, environments } from "@/db/schema";
import { getWebEnv } from "@/env";
import { requirePermission } from "@/lib/authz";
import { dbNameFor, defaultHost, envAllowedForInstance, isValidHostForEnv } from "@/lib/job-contract";
import { parseForm } from "@/lib/job-forms";
import { logger } from "@/lib/logger";
import { actorFromSession, assertSameOrigin, requestMeta } from "@/server/context";

/** env → instance Odoo (scripts/lib/odoo-pools.sh pool_for_env). */
const ODOO_INSTANCE = { prod: "pool-a", demo: "pool-a", staging: "staging" } as const;

export async function createClientAction(formData: FormData): Promise<void> {
  const session = await requirePermission("clients:manage");
  if (!(await assertSameOrigin())) redirect("/clients?r=origin");
  const parsed = parseForm("createClient", formData.entries());
  if (!parsed.success) redirect("/clients?r=invalid");
  const actor = await actorFromSession(session);
  if (!actor) redirect("/clients?r=reauth");
  const meta = await requestMeta();
  let code = "created";
  try {
    await getDb().transaction(async (tx) => {
      const [row] = await tx
        .insert(clients)
        .values({ slug: parsed.data.slug, name: parsed.data.name })
        .returning({ id: clients.id });
      await tx.insert(auditLogs).values({
        actorUserId: actor.userId,
        actor: `user:${actor.sub}`,
        action: "client.create",
        targetType: "client",
        targetId: row?.id ?? null,
        clientId: row?.id ?? null,
        ip: meta.ip,
        requestId: meta.requestId,
        metadata: { slug: parsed.data.slug },
      });
    });
  } catch (err) {
    code = isUniqueViolation(err) ? "exists" : "error";
    if (code === "error") logger.error({ err: safeErrorMessage(err) }, "create client gagal");
  }
  redirect(code === "created" ? `/clients/${parsed.data.slug}?r=created` : `/clients?r=${code}`);
}

export async function createEnvironmentAction(formData: FormData): Promise<void> {
  const session = await requirePermission("clients:manage");
  if (!(await assertSameOrigin())) redirect("/clients?r=origin");
  const parsed = parseForm("createEnvironment", formData.entries());
  if (!parsed.success) redirect("/clients?r=invalid");
  const { clientId, kind, host } = parsed.data;
  const db = getDb();
  const client = (
    await db.select({ id: clients.id, slug: clients.slug, isPlatform: clients.isPlatform }).from(clients).where(eq(clients.id, clientId)).limit(1)
  )[0];
  if (!client) redirect("/clients?r=not_found");
  const slug = client.slug;
  function back(code: string): never {
    redirect(`/clients/${slug}?r=${code}`);
  }
  // Tenant internal `platform` tidak punya environment Odoo (kontrak Fase 1 §1: odoo_* dilarang untuk slug platform).
  if (client.isPlatform) back("invalid");

  const instance = getWebEnv().INFRA_JOBS_INSTANCE;
  if (instance && !envAllowedForInstance(instance, kind)) back("invalid");
  const h = host ?? defaultHost(client.slug, kind);
  if (!h || !isValidHostForEnv(h, kind)) back("invalid");
  const actor = await actorFromSession(session);
  if (!actor) back("reauth");
  const meta = await requestMeta();

  let code = "created";
  try {
    await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(environments)
        .values({
          clientId: client.id,
          kind,
          odooInstance: ODOO_INSTANCE[kind],
          dbName: dbNameFor(client.slug, kind),
          url: `https://${h}`,
        })
        .returning({ id: environments.id });
      await tx.insert(auditLogs).values({
        actorUserId: actor.userId,
        actor: `user:${actor.sub}`,
        action: "environment.create",
        targetType: "environment",
        targetId: row?.id ?? null,
        clientId: client.id,
        ip: meta.ip,
        requestId: meta.requestId,
        metadata: { kind, db_name: dbNameFor(client.slug, kind), url_host: h },
      });
    });
  } catch (err) {
    code = isUniqueViolation(err) ? "exists" : "error";
    if (code === "error") logger.error({ err: safeErrorMessage(err) }, "create environment gagal");
  }
  back(code);
}
