/**
 * Integrasi Domains W5 (Postgres nyata): CRUD superadmin + audit, fqdn unik, tautan environment lintas tenant/purpose,
 * tenant platform/terminated, konfirmasi hapus, token verifikasi server, query per tenant (halaman tenant & portal).
 * Postgres SEKALI PAKAI (TEST_DATABASE_URL; skema di-DROP).
 */
import { and, eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db } from "@/db/client";
import { ensurePlatformTenant } from "@/db/platform";
import { portalDomains } from "@/db/portal-queries";
import { auditLogs, clients, domains, environments, users } from "@/db/schema";
import { listTenantDomains } from "@/db/tenant-queries";
import { createDomain, deleteDomain, updateDomain, type DomainServiceInput } from "@/jobs/domains";
import type { Actor } from "@/jobs/service";

const URL_ = process.env.TEST_DATABASE_URL;
const META = { ip: "203.0.113.12", requestId: "req-domains" };

describe.skipIf(!URL_)("Domains W5 (Postgres nyata)", () => {
  let db: Db;
  let pool: { end: () => Promise<void> };
  let acmeId: string;
  let betaId: string;
  let platformId: string;
  let envAcme: string;
  let envBeta: string;
  let SUPER: Actor;
  let OPS: Actor;
  const svc = (actor: Actor): DomainServiceInput => ({ actor, meta: META });

  beforeAll(async () => {
    ({ db, pool } = createDb(URL_!, { max: 3, applicationName: "cp-int-domains" }));
    await db.execute(sql`DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA IF EXISTS pgboss CASCADE; CREATE SCHEMA public;`);
    await migrate(db, { migrationsFolder: "./drizzle" });
    platformId = (await ensurePlatformTenant(db)).id;
    acmeId = (await db.insert(clients).values({ slug: "acme-co", name: "Acme" }).returning())[0]!.id;
    betaId = (await db.insert(clients).values({ slug: "beta-co", name: "Beta" }).returning())[0]!.id;
    const env = (clientId: string, slug: string) => ({ clientId, kind: "prod" as const, odooInstance: "pool-a", dbName: `${slug}_prod`, url: `https://${slug}.erp.bimacreative.tech` });
    envAcme = (await db.insert(environments).values(env(acmeId, "acme_co")).returning())[0]!.id;
    envBeta = (await db.insert(environments).values(env(betaId, "beta_co")).returning())[0]!.id;
    const sa = (await db.insert(users).values({ keycloakSub: "super-sub", role: "superadmin", clientId: platformId }).returning())[0]!.id;
    const op = (await db.insert(users).values({ keycloakSub: "ops-sub", role: "ops", clientId: platformId }).returning())[0]!.id;
    SUPER = { sub: "super-sub", userId: sa, roles: ["superadmin"] };
    OPS = { sub: "ops-sub", userId: op, roles: ["ops"] };
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
  });

  it("buat: pending_dns, token acak server, tautan env odoo, audit; fqdn unik lintas tenant", async () => {
    const r = await createDomain(db, svc(SUPER), { clientId: acmeId, fqdn: "erp.acme.co.id", purpose: "odoo", environmentId: envAcme });
    expect(r).toMatchObject({ ok: true, slug: "acme-co" });
    const d = (await db.select().from(domains).where(eq(domains.fqdn, "erp.acme.co.id")))[0]!;
    expect(d).toMatchObject({ clientId: acmeId, status: "pending_dns", purpose: "odoo", environmentId: envAcme, dkimTxt: null });
    expect(d.verificationToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const m = await createDomain(db, svc(SUPER), { clientId: acmeId, fqdn: "acme.co.id", purpose: "mail", dkimTxt: "v=DKIM1; k=rsa; p=AB" });
    expect(m.ok).toBe(true);
    const tokens = (await db.select({ t: domains.verificationToken }).from(domains)).map((x) => x.t);
    expect(new Set(tokens).size).toBe(2);
    expect(await createDomain(db, svc(SUPER), { clientId: betaId, fqdn: "erp.acme.co.id", purpose: "web" })).toEqual({ ok: false, reason: "exists", slug: "beta-co" });
    const a = await db.select().from(auditLogs).where(eq(auditLogs.action, "domain.create"));
    expect(a.map((x) => x.result).sort()).toEqual(["rejected", "success", "success"]);
    expect(a.find((x) => x.targetId === d.id)!.metadata).toMatchObject({ fqdn: "erp.acme.co.id", purpose: "odoo", environment_id: envAcme });
    expect(JSON.stringify(a.map((x) => x.metadata))).not.toContain(d.verificationToken);
  });

  it("tautan environment: env tenant lain / purpose selain odoo|web / env tak ada → env_mismatch tanpa baris", async () => {
    const n0 = (await db.select().from(domains)).length;
    const EM = { ok: false, reason: "env_mismatch", slug: "acme-co" };
    expect(await createDomain(db, svc(SUPER), { clientId: acmeId, fqdn: "web.acme.co.id", purpose: "web", environmentId: envBeta })).toEqual(EM);
    expect(await createDomain(db, svc(SUPER), { clientId: acmeId, fqdn: "mail2.acme.co.id", purpose: "mail", environmentId: envAcme })).toEqual(EM);
    expect(await createDomain(db, svc(SUPER), { clientId: acmeId, fqdn: "x.acme.co.id", purpose: "odoo", environmentId: "0b0b0b0b-0000-4000-8000-000000000000" })).toEqual(EM);
    const d = (await db.select().from(domains).where(eq(domains.fqdn, "erp.acme.co.id")))[0]!;
    expect(await updateDomain(db, svc(SUPER), { domainId: d.id, purpose: "odoo", environmentId: envBeta })).toEqual(EM);
    expect((await db.select().from(domains)).length).toBe(n0);
  });

  it("izin & tenant: ops → forbidden (diaudit); tenant platform / terminated / tak ada → ditolak", async () => {
    expect(await createDomain(db, svc(OPS), { clientId: acmeId, fqdn: "ops.acme.co.id", purpose: "web" })).toEqual({ ok: false, reason: "forbidden" });
    expect(await createDomain(db, svc(SUPER), { clientId: platformId, fqdn: "x.bimacreative.tech", purpose: "web" })).toEqual({ ok: false, reason: "tenant_inactive", slug: "platform" });
    expect(await createDomain(db, svc(SUPER), { clientId: "0c0c0c0c-0000-4000-8000-000000000000", fqdn: "y.co.id", purpose: "web" })).toEqual({ ok: false, reason: "not_found" });
    await db.update(clients).set({ status: "terminated" }).where(eq(clients.id, betaId));
    expect(await createDomain(db, svc(SUPER), { clientId: betaId, fqdn: "b.beta.co.id", purpose: "web" })).toEqual({ ok: false, reason: "tenant_inactive", slug: "beta-co" });
    await db.update(clients).set({ status: "active" }).where(eq(clients.id, betaId));
    const rej = await db.select().from(auditLogs).where(and(eq(auditLogs.result, "rejected"), eq(auditLogs.actorUserId, OPS.userId!)));
    expect(rej.map((x) => x.action)).toEqual(["domain.create"]);
  });

  it("ubah: purpose/env/DKIM (DKIM dibuang untuk non-mail), audit from/to; fqdn tetap", async () => {
    const d = (await db.select().from(domains).where(eq(domains.fqdn, "acme.co.id")))[0]!;
    expect(await updateDomain(db, svc(OPS), { domainId: d.id, purpose: "web" })).toEqual({ ok: false, reason: "forbidden" });
    expect(await updateDomain(db, svc(SUPER), { domainId: d.id, purpose: "mail", dkimTxt: "v=DKIM1; k=rsa; p=CD" })).toMatchObject({ ok: true });
    expect((await db.select().from(domains).where(eq(domains.id, d.id)))[0]!.dkimTxt).toBe("v=DKIM1; k=rsa; p=CD");
    expect(await updateDomain(db, svc(SUPER), { domainId: d.id, purpose: "web", environmentId: envAcme, dkimTxt: "v=DKIM1; p=X" })).toMatchObject({ ok: true });
    const after = (await db.select().from(domains).where(eq(domains.id, d.id)))[0]!;
    expect(after).toMatchObject({ fqdn: "acme.co.id", purpose: "web", environmentId: envAcme, dkimTxt: null });
    const u = await db.select().from(auditLogs).where(and(eq(auditLogs.action, "domain.update"), eq(auditLogs.result, "success")));
    expect(u.at(-1)!.metadata).toMatchObject({ fqdn: "acme.co.id", from: { purpose: "mail", has_dkim: true }, to: { purpose: "web", environment_id: envAcme, has_dkim: false } });
    expect(await updateDomain(db, svc(SUPER), { domainId: "0d0d0d0d-0000-4000-8000-000000000000", purpose: "web" })).toEqual({ ok: false, reason: "not_found" });
  });

  it("query per tenant: halaman tenant & portal hanya domain tenant itu (+ kind env)", async () => {
    await createDomain(db, svc(SUPER), { clientId: betaId, fqdn: "beta.co.id", purpose: "mail" });
    const acme = await listTenantDomains(db, acmeId);
    expect(acme.map((x) => x.fqdn)).toEqual(["acme.co.id", "erp.acme.co.id"]);
    expect(acme.find((x) => x.fqdn === "erp.acme.co.id")!.envKind).toBe("prod");
    expect((await portalDomains(db, betaId)).map((x) => x.fqdn)).toEqual(["beta.co.id"]);
  });

  it("hapus: wajib ketik fqdn persis; audit; ops ditolak", async () => {
    const d = (await db.select().from(domains).where(eq(domains.fqdn, "erp.acme.co.id")))[0]!;
    expect(await deleteDomain(db, svc(SUPER), { domainId: d.id, confirm: "acme.co.id" })).toEqual({ ok: false, reason: "confirm", slug: "acme-co" });
    expect(await deleteDomain(db, svc(OPS), { domainId: d.id, confirm: "erp.acme.co.id" })).toEqual({ ok: false, reason: "forbidden" });
    expect(await deleteDomain(db, svc(SUPER), { domainId: d.id, confirm: "erp.acme.co.id" })).toEqual({ ok: true, id: d.id, slug: "acme-co" });
    expect(await db.select().from(domains).where(eq(domains.id, d.id))).toHaveLength(0);
    const del = await db.select().from(auditLogs).where(eq(auditLogs.action, "domain.delete"));
    expect(del.map((x) => x.result).sort()).toEqual(["rejected", "rejected", "success"]);
    expect(del.find((x) => x.result === "success")).toMatchObject({ targetId: d.id, clientId: acmeId, actor: "user:super-sub" });
  });
});
