/**
 * Migrasi 0005 (ADR 0018, aditif): (1) 0000..0005 di DB kosong + langkah boot (platform + 7 plan, idempoten);
 * (2) 0005 di atas DB yang SUDAH di 0004 berisi data (meniru prod/staging) → data lama utuh, kolom/enum/indeks baru,
 * FK aktor audit/job menjadi RESTRICT. Postgres SEKALI PAKAI (skema di-DROP).
 */
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db } from "@/db/client";
import { ensureInitialPlans } from "@/db/plans";
import { pgErrorInfo } from "@/db/errors";
import { ensurePlatformTenant } from "@/db/platform";

const URL_ = process.env.TEST_DATABASE_URL;
/** SQLSTATE + constraint dari error (DrizzleQueryError membungkus error pg). */
async function pgError(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    return pgErrorInfo(e);
  }
  throw new Error("query tidak gagal");
}

const RESET = sql`DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA IF EXISTS pgboss CASCADE; CREATE SCHEMA public;`;

describe.skipIf(!URL_)("migrasi 0005 (ADR 0018)", () => {
  let db: Db;
  let pool: { end: () => Promise<void> };
  let dir: string;

  beforeAll(async () => {
    ({ db, pool } = createDb(URL_!, { max: 2, applicationName: "cp-int-mig5" }));
  });

  afterAll(async () => {
    await pool?.end();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  describe("0000..0005 di DB kosong", () => {
    beforeAll(async () => {
      await db.execute(RESET);
      await migrate(db, { migrationsFolder: "./drizzle" });
    });

    it("6 migrasi; langkah boot idempoten: platform + 7 plan harga NULL", async () => {
      const r = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`);
      expect(r.rows[0]!.n).toBe(6);
      await ensurePlatformTenant(db);
      expect(await ensureInitialPlans(db)).toEqual({ created: 7, total: 7 });
      expect(await ensureInitialPlans(db)).toEqual({ created: 0, total: 7 });
      // harga yang diisi kemudian tidak tertimpa langkah boot berikutnya
      await db.execute(sql`UPDATE plans SET price_amount = 1500000 WHERE code = 'odoo-shared-s'`);
      await ensureInitialPlans(db);
      const p = await db.execute<{ code: string; service: string; price_amount: string | null; billing_period_months: number }>(
        sql`SELECT code, service::text, price_amount, billing_period_months FROM plans ORDER BY code`,
      );
      expect(p.rows).toHaveLength(7);
      expect(p.rows.find((x) => x.code === "odoo-shared-s")!.price_amount).toBe("1500000.00");
      expect(p.rows.filter((x) => x.price_amount === null)).toHaveLength(6);
      expect(new Set(p.rows.map((x) => x.service))).toEqual(new Set(["odoo", "mail", "web", "insight"]));
      expect(p.rows.every((x) => x.billing_period_months === 1)).toBe(true);
    });

    it("enum subscription_status += implementation/warranty/past_due (pending/grace tetap ada)", async () => {
      const t = await db.execute<{ v: string }>(sql`SELECT unnest(enum_range(NULL::subscription_status))::text AS v`);
      expect(t.rows.map((r) => r.v)).toEqual(["pending", "active", "grace", "suspended", "terminated", "implementation", "warranty", "past_due"]);
    });
  });

  describe("0005 di atas DB 0004 berisi data", () => {
    beforeAll(async () => {
      await db.execute(RESET);
      dir = await mkdtemp(path.join(tmpdir(), "cp-mig5-"));
      await cp("./drizzle", dir, { recursive: true });
      const journalPath = path.join(dir, "meta", "_journal.json");
      const journal = JSON.parse(await readFile(journalPath, "utf8")) as { entries: { tag: string }[] };
      expect(journal.entries.map((e) => e.tag)).toContain("0005_saas_p1_billing");
      journal.entries = journal.entries.filter((e) => e.tag < "0005");
      await writeFile(journalPath, JSON.stringify(journal));
      await migrate(db, { migrationsFolder: dir });
      await db.execute(sql`
        INSERT INTO clients (id, slug, name, is_platform) VALUES
          ('aaaaaaaa-0000-4000-8000-000000000001', 'demo', 'Demo tenant', false),
          ('aaaaaaaa-0000-4000-8000-0000000000ff', 'platform', 'Platform', true);
        INSERT INTO environments (id, client_id, kind, odoo_instance, db_name, url, host, db_status, route_status, sso_status)
          VALUES ('bbbbbbbb-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', 'demo', 'pool-a', 'demo_demo',
                  'https://demo.erp.bimacreative.tech', 'demo.erp.bimacreative.tech', 'provisioned', 'active', 'active');
        INSERT INTO users (id, keycloak_sub, email, role, client_id, status) VALUES
          ('cccccccc-0000-4000-8000-000000000001', 'sub-super', 'ops@example.com', 'superadmin', 'aaaaaaaa-0000-4000-8000-0000000000ff', 'active'),
          ('cccccccc-0000-4000-8000-000000000009', 'sub-noaudit', NULL, 'client_user', 'aaaaaaaa-0000-4000-8000-000000000001', 'disabled');
        INSERT INTO plans (id, code, name, price_amount) VALUES ('eeeeeeee-0000-4000-8000-000000000001', 'legacy', 'Legacy plan', 100000);
        INSERT INTO subscriptions (id, client_id, plan_id, status) VALUES
          ('ffffffff-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', 'eeeeeeee-0000-4000-8000-000000000001', 'pending');
        INSERT INTO invoices (id, number, client_id, subscription_id, amount, due_at) VALUES
          ('99999999-0000-4000-8000-000000000001', 'LEGACY-1', 'aaaaaaaa-0000-4000-8000-000000000001', 'ffffffff-0000-4000-8000-000000000001', 100000, now());
        INSERT INTO domains (client_id, fqdn, verification_token) VALUES ('aaaaaaaa-0000-4000-8000-000000000001', 'erp.demo.example', 'tok-1');
        INSERT INTO provision_jobs (id, type, status, client_id, env, actor, actor_user_id)
          VALUES ('dddddddd-0000-4000-8000-000000000001', 'kc_user_ensure', 'succeeded', 'aaaaaaaa-0000-4000-8000-000000000001', 'demo',
                  'user:sub-super', 'cccccccc-0000-4000-8000-000000000001');
        INSERT INTO audit_logs (actor_user_id, actor, action) VALUES ('cccccccc-0000-4000-8000-000000000001', 'user:sub-super', 'user.add');
      `);
      await migrate(db, { migrationsFolder: "./drizzle" });
    });

    it("hanya 0005 yang diterapkan; idempoten", async () => {
      const r = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`);
      expect(r.rows[0]!.n).toBe(6);
      await migrate(db, { migrationsFolder: "./drizzle" });
      const r2 = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`);
      expect(r2.rows[0]!.n).toBe(6);
    });

    it("data lama utuh + default/NULL kolom baru", async () => {
      const s = await db.execute(sql`SELECT status::text, go_live_at, warranty_until, notes FROM subscriptions`);
      expect(s.rows).toEqual([{ status: "pending", go_live_at: null, warranty_until: null, notes: null }]);
      const i = await db.execute(sql`SELECT number, kind::text, proof_reference, period_start, period_end, amount FROM invoices`);
      expect(i.rows).toEqual([{ number: "LEGACY-1", kind: "maintenance", proof_reference: null, period_start: null, period_end: null, amount: "100000.00" }]);
      const p = await db.execute(sql`SELECT code, service, price_amount FROM plans`);
      expect(p.rows).toEqual([{ code: "legacy", service: null, price_amount: "100000.00" }]);
      const d = await db.execute(sql`SELECT fqdn, purpose, dkim_txt, last_check FROM domains`);
      expect(d.rows).toEqual([{ fqdn: "erp.demo.example", purpose: null, dkim_txt: null, last_check: null }]);
      const e = await db.execute(sql`SELECT db_name, tenant_check, route_status::text FROM environments`);
      expect(e.rows).toEqual([{ db_name: "demo_demo", tenant_check: null, route_status: "active" }]);
      const a = await db.execute(sql`SELECT actor_user_id FROM audit_logs`);
      expect(a.rows).toEqual([{ actor_user_id: "cccccccc-0000-4000-8000-000000000001" }]);
    });

    it("price_amount nullable; CHECK tenant_check & periode invoice; enum baru dipakai setelah commit", async () => {
      await db.execute(sql`INSERT INTO plans (code, name, service) VALUES ('nullprice', 'x', 'odoo')`);
      await expect(db.execute(sql`INSERT INTO plans (code, name, price_amount) VALUES ('neg', 'x', -1)`)).rejects.toThrow();
      await expect(db.execute(sql`UPDATE environments SET tenant_check = 'loose'`)).rejects.toThrow();
      await db.execute(sql`UPDATE environments SET tenant_check = 'compat'`);
      await db.execute(sql`UPDATE subscriptions SET status = 'warranty', go_live_at = '2026-10-01', warranty_until = '2026-12-01'`);
      await expect(
        db.execute(sql`INSERT INTO invoices (number, client_id, amount, due_at, period_start, period_end)
                       VALUES ('X-2', 'aaaaaaaa-0000-4000-8000-000000000001', 1, now(), '2026-10-01', '2026-10-01')`),
      ).rejects.toThrow();
      await expect(db.execute(sql`INSERT INTO domains (client_id, fqdn, verification_token, purpose) VALUES ('aaaaaaaa-0000-4000-8000-000000000001', 'x.example', 't', 'ftp')`)).rejects.toThrow();
    });

    it("satu invoice maintenance non-void per (subscription, periode)", async () => {
      const ins = (n: string, status = "unpaid") =>
        db.execute(sql`INSERT INTO invoices (number, client_id, subscription_id, amount, due_at, kind, status, period_start, period_end)
          VALUES (${n}, 'aaaaaaaa-0000-4000-8000-000000000001', 'ffffffff-0000-4000-8000-000000000001', 1, now(), 'maintenance', ${status}::invoice_status, '2026-12-01', '2027-01-01')`);
      await ins("INV/2026/12/0001", "void");
      await ins("INV/2026/12/0002");
      expect(await pgError(ins("INV/2026/12/0003"))).toEqual({ code: "23505", constraint: "invoices_maintenance_period_uq" });
    });

    it("FK aktor audit_logs/provision_jobs = RESTRICT: user beraudit tidak bisa dihapus; user tanpa jejak bisa", async () => {
      const fk = await db.execute<{ conname: string; confdeltype: string }>(sql`
        SELECT conname, confdeltype FROM pg_constraint
        WHERE conname IN ('audit_logs_actor_user_id_users_id_fk', 'provision_jobs_actor_user_id_users_id_fk') ORDER BY conname`);
      expect(fk.rows).toEqual([
        { conname: "audit_logs_actor_user_id_users_id_fk", confdeltype: "r" },
        { conname: "provision_jobs_actor_user_id_users_id_fk", confdeltype: "r" },
      ]);
      const e = await pgError(db.execute(sql`DELETE FROM users WHERE id = 'cccccccc-0000-4000-8000-000000000001'`));
      expect(e.code).toBe("23503");
      expect(e.constraint).toMatch(/^(audit_logs|provision_jobs)_actor_user_id_users_id_fk$/);
      const still = await db.execute(sql`SELECT actor_user_id FROM audit_logs`);
      expect(still.rows).toEqual([{ actor_user_id: "cccccccc-0000-4000-8000-000000000001" }]);
      await db.execute(sql`DELETE FROM users WHERE id = 'cccccccc-0000-4000-8000-000000000009'`);
    });

    it("notification_log: kunci unik + format; status ter-allowlist", async () => {
      await db.execute(sql`INSERT INTO notification_log (key, kind) VALUES ('admin_check:2026-10-03', 'admin_check')`);
      await expect(db.execute(sql`INSERT INTO notification_log (key, kind) VALUES ('admin_check:2026-10-03', 'admin_check')`)).rejects.toThrow();
      await expect(db.execute(sql`INSERT INTO notification_log (key, kind) VALUES ('Bad Key!', 'x')`)).rejects.toThrow();
      await expect(db.execute(sql`INSERT INTO notification_log (key, kind, status) VALUES ('k:1', 'x', 'bounced')`)).rejects.toThrow();
    });
  });
});
