/**
 * Migrasi 0004 (kontrak Fase 1 §2.1) di atas DB yang SUDAH di 0003 dengan data (meniru prod/staging): migrasi
 * 0000..0003 dari salinan folder ./drizzle yang journal-nya dipotong → seed baris → migrasi penuh (hanya 0004 yang
 * jalan) → data lama utuh, default kolom baru benar, constraint baru aktif. Postgres SEKALI PAKAI (skema di-DROP).
 */
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db } from "@/db/client";
import { ensurePlatformTenant } from "@/db/platform";

const URL_ = process.env.TEST_DATABASE_URL;

describe.skipIf(!URL_)("migrasi 0004 di atas DB 0003 berisi data", () => {
  let db: Db;
  let pool: { end: () => Promise<void> };
  let dir: string;

  beforeAll(async () => {
    ({ db, pool } = createDb(URL_!, { max: 2, applicationName: "cp-int-mig" }));
    await db.execute(sql`DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA IF EXISTS pgboss CASCADE; CREATE SCHEMA public;`);
    dir = await mkdtemp(path.join(tmpdir(), "cp-mig-"));
    await cp("./drizzle", dir, { recursive: true });
    const journalPath = path.join(dir, "meta", "_journal.json");
    const journal = JSON.parse(await readFile(journalPath, "utf8")) as { entries: { tag: string }[] };
    expect(journal.entries.map((e) => e.tag)).toContain("0004_saas_p1_users");
    journal.entries = journal.entries.filter((e) => e.tag < "0004");
    await writeFile(journalPath, JSON.stringify(journal));
    await migrate(db, { migrationsFolder: dir });

    // Seed seperti prod/staging hari ini (tanpa kolom 0004).
    await db.execute(sql`
      INSERT INTO clients (id, slug, name) VALUES
        ('aaaaaaaa-0000-4000-8000-000000000001', 'demo', 'Demo tenant'),
        ('aaaaaaaa-0000-4000-8000-000000000002', 'ssotest', 'SSO test');
      INSERT INTO environments (id, client_id, kind, odoo_instance, db_name, url, host, db_status, route_status, sso_status)
        VALUES ('bbbbbbbb-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', 'demo', 'pool-a', 'demo_demo',
                'https://demo.erp.bimacreative.tech', 'demo.erp.bimacreative.tech', 'provisioned', 'active', 'active');
      INSERT INTO users (id, keycloak_sub, email, role, client_id) VALUES
        ('cccccccc-0000-4000-8000-000000000001', 'sub-super', 'ops@example.com', 'superadmin', NULL),
        ('cccccccc-0000-4000-8000-000000000002', 'sub-admin', 'adm@demo.example', 'client_admin', 'aaaaaaaa-0000-4000-8000-000000000001'),
        ('cccccccc-0000-4000-8000-000000000003', 'sub-user', 'usr@demo.example', 'client_user', 'aaaaaaaa-0000-4000-8000-000000000001');
      INSERT INTO provision_jobs (id, type, status, client_id, environment_id, env, actor, actor_user_id, error_code)
        VALUES ('dddddddd-0000-4000-8000-000000000001', 'odoo_sso_user', 'succeeded', 'aaaaaaaa-0000-4000-8000-000000000001',
                'bbbbbbbb-0000-4000-8000-000000000001', 'demo', 'user:sub-super', 'cccccccc-0000-4000-8000-000000000001', NULL),
               ('dddddddd-0000-4000-8000-000000000002', 'odoo_route', 'failed', 'aaaaaaaa-0000-4000-8000-000000000001',
                'bbbbbbbb-0000-4000-8000-000000000001', 'demo', 'user:sub-super', NULL, 'result_inconsistent');
      INSERT INTO audit_logs (actor_user_id, actor, action) VALUES ('cccccccc-0000-4000-8000-000000000001', 'user:sub-super', 'client.create');
      INSERT INTO tenant_user_access (environment_id, email, status) VALUES ('bbbbbbbb-0000-4000-8000-000000000001', 'usr@demo.example', 'inconsistent');
    `);
    // Sekarang migrasi penuh: hanya 0004 yang belum diterapkan.
    await migrate(db, { migrationsFolder: "./drizzle" });
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("journal drizzle: 5 migrasi tercatat; 0004 tidak diterapkan dua kali", async () => {
    const r = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`);
    expect(r.rows[0]!.n).toBe(5);
    await migrate(db, { migrationsFolder: "./drizzle" });
    const r2 = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`);
    expect(r2.rows[0]!.n).toBe(5);
  });

  it("data lama utuh + default kolom baru", async () => {
    const c = await db.execute(sql`SELECT slug, status, isolation, brand, kc_org_id, is_platform FROM clients ORDER BY slug`);
    expect(c.rows).toEqual([
      { slug: "demo", status: "active", isolation: "shared", brand: null, kc_org_id: null, is_platform: false },
      { slug: "ssotest", status: "active", isolation: "shared", brand: null, kc_org_id: null, is_platform: false },
    ]);
    const u = await db.execute(sql`SELECT keycloak_sub, status, invited_by, disabled_at, role FROM users ORDER BY keycloak_sub`);
    expect(u.rows).toEqual([
      { keycloak_sub: "sub-admin", status: "active", invited_by: null, disabled_at: null, role: "client_admin" },
      { keycloak_sub: "sub-super", status: "active", invited_by: null, disabled_at: null, role: "superadmin" },
      { keycloak_sub: "sub-user", status: "active", invited_by: null, disabled_at: null, role: "client_user" },
    ]);
    const j = await db.execute(sql`SELECT id, idempotency_key, after_job_id, chain_id, actor_user_id, error_code FROM provision_jobs ORDER BY id`);
    expect(j.rows).toEqual([
      { id: "dddddddd-0000-4000-8000-000000000001", idempotency_key: null, after_job_id: null, chain_id: null, actor_user_id: "cccccccc-0000-4000-8000-000000000001", error_code: null },
      { id: "dddddddd-0000-4000-8000-000000000002", idempotency_key: null, after_job_id: null, chain_id: null, actor_user_id: null, error_code: "result_inconsistent" },
    ]);
    const a = await db.execute(sql`SELECT actor_user_id FROM audit_logs`);
    expect(a.rows).toEqual([{ actor_user_id: "cccccccc-0000-4000-8000-000000000001" }]);
  });

  it("enum job_type += 10 tipe; CHECK error_code += chain_aborted; nilai lama tetap valid", async () => {
    const t = await db.execute<{ v: string }>(sql`SELECT unnest(enum_range(NULL::job_type))::text AS v`);
    const types = t.rows.map((r) => r.v);
    for (const n of ["kc_realm_sync", "kc_org_ensure", "kc_user_ensure", "kc_user_set_roles", "kc_user_set_enabled", "kc_user_action_email", "odoo_user_ensure", "odoo_tenant_config", "tenant_suspend", "tenant_resume"]) {
      expect(types).toContain(n);
    }
    await db.execute(sql`INSERT INTO provision_jobs (type, status, actor, error_code) VALUES ('tenant_resume', 'cancelled', 'system:t', 'chain_aborted')`);
    await expect(db.execute(sql`INSERT INTO provision_jobs (type, actor, error_code) VALUES ('noop', 'system:t', 'nope')`)).rejects.toThrow();
  });

  it("indeks parsial: satu tenant-admin invited/active per tenant; satu platform; idempotency_key unik", async () => {
    await expect(
      db.execute(sql`INSERT INTO users (keycloak_sub, role, client_id, status) VALUES ('sub-admin2', 'client_admin', 'aaaaaaaa-0000-4000-8000-000000000001', 'invited')`),
    ).rejects.toThrow();
    // admin disabled tidak dihitung; admin di tenant lain boleh
    await db.execute(sql`INSERT INTO users (keycloak_sub, role, client_id, status) VALUES ('sub-admin3', 'client_admin', 'aaaaaaaa-0000-4000-8000-000000000001', 'disabled')`);
    await db.execute(sql`INSERT INTO users (keycloak_sub, role, client_id, status) VALUES ('sub-admin4', 'client_admin', 'aaaaaaaa-0000-4000-8000-000000000002', 'invited')`);

    const p = await ensurePlatformTenant(db);
    expect(p.created).toBe(true);
    await expect(db.execute(sql`INSERT INTO clients (slug, name, is_platform) VALUES ('platform-x', 'x', true)`)).rejects.toThrow();

    await db.execute(sql`INSERT INTO provision_jobs (type, actor, idempotency_key) VALUES ('kc_user_ensure', 'system:t', 'k:1')`);
    await expect(db.execute(sql`INSERT INTO provision_jobs (type, actor, idempotency_key) VALUES ('kc_user_ensure', 'system:t', 'k:1')`)).rejects.toThrow();
    // NULL tidak bentrok (tipe lama / dry-run)
    await db.execute(sql`INSERT INTO provision_jobs (type, actor) VALUES ('noop', 'system:t'), ('noop', 'system:t')`);
    // FK users.invited_by dan provision_jobs.after_job_id
    await expect(db.execute(sql`UPDATE users SET invited_by = '99999999-9999-4999-8999-999999999999' WHERE keycloak_sub = 'sub-user'`)).rejects.toThrow();
    await expect(
      db.execute(sql`INSERT INTO provision_jobs (type, actor, after_job_id) VALUES ('noop', 'system:t', '99999999-9999-4999-8999-999999999999')`),
    ).rejects.toThrow();
  });
});
