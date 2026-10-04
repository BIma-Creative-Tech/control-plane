import { describe, expect, it } from "vitest";
import { TENANT_SYNC_TYPES, buildTenantSyncSteps, parseTenantForm, retryableOrigin } from "@/lib/tenant-onboarding";

const T = "11111111-1111-4111-8111-111111111111";
const entries = (o: Record<string, string>) => Object.entries(o) as [string, string][];

describe("Sinkronkan tenant (tenant terdaftar, 2026-10-04)", () => {
  it("rantai: kc_org_ensure (realm instance) → odoo_tenant_config(mode) per env ber-SSO aktif", () => {
    const steps = buildTenantSyncSteps({
      tenantId: T,
      realmEnv: "prod",
      envs: [
        { kind: "prod", ssoStatus: "active" },
        { kind: "demo", ssoStatus: "none" },
      ],
      tenantCheck: "strict",
    });
    expect(steps).toEqual([
      { type: "kc_org_ensure", env: "prod", args: { tenant_id: T } },
      { type: "odoo_tenant_config", env: "prod", args: { tenant_check: "strict" } },
    ]);
  });

  it("tanpa env ber-SSO aktif: hanya org", () => {
    const steps = buildTenantSyncSteps({ tenantId: T, realmEnv: "staging", envs: [{ kind: "staging", ssoStatus: "none" }], tenantCheck: "compat" });
    expect(steps.map((s) => s.type)).toEqual(["kc_org_ensure"]);
  });

  it("tipe yang dibutuhkan", () => {
    expect([...TENANT_SYNC_TYPES]).toEqual(["kc_org_ensure", "odoo_tenant_config"]);
  });

  it("form: clientId UUID + tenant_check off|compat|strict, kunci lain ditolak", () => {
    for (const mode of ["off", "compat", "strict"]) {
      expect(parseTenantForm("tenantSync", entries({ clientId: T, tenant_check: mode }))).toEqual({
        success: true,
        data: { clientId: T, tenant_check: mode },
      });
    }
    expect(parseTenantForm("tenantSync", entries({ clientId: T, tenant_check: "on" })).success).toBe(false);
    expect(parseTenantForm("tenantSync", entries({ clientId: "acme", tenant_check: "compat" })).success).toBe(false);
    expect(parseTenantForm("tenantSync", entries({ clientId: T, tenant_check: "compat", extra: "x" })).success).toBe(false);
  });

  it("rantai tenant.sync boleh diulang dari langkah gagal", () => {
    expect(retryableOrigin("tenant.sync")).toBe(true);
  });
});
