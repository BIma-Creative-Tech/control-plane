/**
 * ADR 0018 — rekonsiliasi job tenant (RESULT state/mode), halaman publik /suspended (statis, tanpa kebocoran), env
 * worker SMTP/TICK_NOW, dan seed plan D7.
 */
import { readFile } from "node:fs/promises";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import SuspendedIndex from "@/app/suspended/page";
import SuspendedSlug from "@/app/suspended/[slug]/page";
import { INITIAL_PLANS } from "@/db/plans";
import { parseEnv, workerEnvSchema } from "@/env";
import { planTenantReconcile, type TenantReconcileJob } from "@/jobs/tenant-reconcile";

const CLIENT = "aaaaaaaa-0000-4000-8000-000000000001";
const job = (o: Partial<TenantReconcileJob>): TenantReconcileJob => ({
  type: "tenant_suspend",
  env: "prod",
  dryRun: false,
  clientId: CLIENT,
  args: {},
  status: "succeeded",
  result: { route: "acme-prod.yml", state: "suspended", changed: "1" },
  ...o,
});

describe("rekonsiliasi tenant_suspend/resume → clients.status, odoo_tenant_config → environments.tenant_check", () => {
  it("state sesuai tipe job → status tenant", () => {
    expect(planTenantReconcile(job({}))).toMatchObject({ kind: "tenant_status", clientId: CLIENT, status: "suspended" });
    expect(planTenantReconcile(job({ type: "tenant_resume", result: { state: "active", changed: "1" } }))).toMatchObject({
      kind: "tenant_status",
      status: "active",
    });
    // idempoten: changed=0 tetap memastikan status
    expect(planTenantReconcile(job({ result: { state: "suspended", changed: "0" } }))).toMatchObject({ kind: "tenant_status" });
  });

  it("RESULT bertentangan / hilang / tidak valid → tidak diubah (+ peringatan)", () => {
    const a = planTenantReconcile(job({ result: { state: "active" } }));
    expect(a.kind).toBe("none");
    expect(a.warnings.join(" ")).toMatch(/bertentangan/);
    expect(planTenantReconcile(job({ type: "tenant_resume", result: { state: "suspended" } })).kind).toBe("none");
    expect(planTenantReconcile(job({ result: {} })).kind).toBe("none");
    expect(planTenantReconcile(job({ result: { state: "SUSPENDED" } })).kind).toBe("none");
  });

  it("gagal / dry-run / tanpa client / tipe lain → none", () => {
    expect(planTenantReconcile(job({ status: "failed" })).kind).toBe("none");
    expect(planTenantReconcile(job({ dryRun: true })).kind).toBe("none");
    expect(planTenantReconcile(job({ result: { state: "suspended", mode: "dry-run" } })).kind).toBe("none");
    expect(planTenantReconcile(job({ clientId: null })).kind).toBe("none");
    expect(planTenantReconcile(job({ type: "kc_user_ensure" })).kind).toBe("none");
  });

  it("odoo_tenant_config: mode RESULT disimpan per env; mode beda dari args → peringatan, nilai host tetap", () => {
    expect(planTenantReconcile(job({ type: "odoo_tenant_config", env: "demo", args: { tenant_check: "compat" }, result: { db: "acme_demo", mode: "compat", changed: "1" } }))).toEqual({
      kind: "tenant_check",
      clientId: CLIENT,
      env: "demo",
      mode: "compat",
      warnings: [],
    });
    const m = planTenantReconcile(job({ type: "odoo_tenant_config", args: { tenant_check: "strict" }, result: { mode: "off" } }));
    expect(m).toMatchObject({ kind: "tenant_check", mode: "off" });
    expect(m.warnings).toHaveLength(1);
    expect(planTenantReconcile(job({ type: "odoo_tenant_config", args: { tenant_check: "strict" }, result: { mode: "bogus" } })).kind).toBe("none");
    expect(planTenantReconcile(job({ type: "odoo_tenant_config", args: { tenant_check: "strict" }, result: { mode: "plan" } })).kind).toBe("none");
  });
});

describe("halaman publik /suspended", () => {
  it("statis dan identik untuk slug ada/tidak ada; slug tidak dipantulkan", () => {
    const a = renderToStaticMarkup(SuspendedSlug());
    const b = renderToStaticMarkup(SuspendedIndex());
    expect(a).toBe(b);
    expect(a).toContain("Layanan sedang ditangguhkan");
    expect(a).toContain("billing@bimacreative.tech");
    expect(a).not.toMatch(/<script|style=/);
  });

  it("tidak membaca sesi/DB/params (tidak ada lookup tenant)", async () => {
    for (const f of ["src/app/suspended/page.tsx", "src/app/suspended/[slug]/page.tsx", "src/app/suspended/notice.tsx"]) {
      const src = await readFile(f, "utf8");
      expect(src).not.toMatch(/@\/auth|@\/db|@\/server|requirePermission|params|searchParams|headers\(/);
    }
  });
});

describe("env worker (ADR 0018 D5/D8)", () => {
  const base = { NODE_ENV: "production", DATABASE_URL: "postgresql://cp:x@postgres:5432/cp" };
  it("default: email nonaktif, from/billing default, TLS wajib", () => {
    const env = parseEnv(workerEnvSchema, base);
    expect(env.SMTP_HOST).toBeUndefined();
    expect(env.SMTP_PORT).toBe(587);
    expect(env.SMTP_TLS).toBe("required");
    expect(env.SMTP_FROM).toBe("noreply@bimacreative.tech");
    expect(env.BILLING_EMAIL).toBe("billing@bimacreative.tech");
  });
  it("SMTP_USER dan SMTP_PASSWORD_FILE wajib berpasangan; tidak ada env password", () => {
    expect(() => parseEnv(workerEnvSchema, { ...base, SMTP_HOST: "mail.bimacreative.tech", SMTP_USER: "noreply@bimacreative.tech" })).toThrow(/SMTP_USER/);
    const env = parseEnv(workerEnvSchema, {
      ...base,
      SMTP_HOST: "mail.bimacreative.tech",
      SMTP_USER: "noreply@bimacreative.tech",
      SMTP_PASSWORD_FILE: "/run/secrets/smtp_password",
    });
    expect(env.SMTP_PASSWORD_FILE).toBe("/run/secrets/smtp_password");
    expect(() => parseEnv(workerEnvSchema, { ...base, SMTP_PASSWORD_FILE: "/run/../etc/shadow", SMTP_USER: "x" })).toThrow();
  });
  it("SMTP_TLS=off hanya staging", () => {
    expect(() => parseEnv(workerEnvSchema, { ...base, SMTP_HOST: "mailpit", SMTP_TLS: "off" })).toThrow(/SMTP_TLS/);
    expect(() => parseEnv(workerEnvSchema, { ...base, SMTP_HOST: "mailpit", SMTP_TLS: "off", INFRA_JOBS_INSTANCE: "prod" })).toThrow(/SMTP_TLS/);
    expect(parseEnv(workerEnvSchema, { ...base, SMTP_HOST: "mailpit", SMTP_PORT: "1025", SMTP_TLS: "off", INFRA_JOBS_INSTANCE: "staging" }).SMTP_PORT).toBe(1025);
  });
  it("TICK_NOW format YYYY-MM-DD", () => {
    expect(parseEnv(workerEnvSchema, { ...base, TICK_NOW: "2027-03-01" }).TICK_NOW).toBe("2027-03-01");
    expect(() => parseEnv(workerEnvSchema, { ...base, TICK_NOW: "2027-03-01T00:00:00Z" })).toThrow(/TICK_NOW/);
  });
});

describe("plan awal ADR 0018 D7", () => {
  it("7 plan, kode unik, harga tidak diisi seed, periode bulanan, layanan terisi", () => {
    expect(INITIAL_PLANS.map((p) => p.code)).toEqual([
      "odoo-shared-s",
      "odoo-shared-m",
      "odoo-dedicated",
      "mail-5",
      "mail-20",
      "web-profile",
      "insight-basic",
    ]);
    for (const p of INITIAL_PLANS) {
      expect(p.billingPeriodMonths).toBe(1);
      expect(p.service).toMatch(/^(odoo|mail|web|insight)$/);
      expect("priceAmount" in p).toBe(false);
    }
    expect(INITIAL_PLANS.find((p) => p.code === "odoo-shared-s")).toMatchObject({ maxUsers: 5, maxEnvironments: 1 });
    expect(INITIAL_PLANS.find((p) => p.code === "odoo-shared-m")).toMatchObject({ maxUsers: 15, maxEnvironments: 2 });
    expect(INITIAL_PLANS.find((p) => p.code === "mail-20")).toMatchObject({ maxMailboxes: 20, features: { mailbox_quota_mb: 2048 } });
    expect(INITIAL_PLANS.find((p) => p.code === "odoo-dedicated")?.features).toMatchObject({ isolation: "dedicated", workers: 2 });
  });
});
