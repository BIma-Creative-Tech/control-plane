/** ADR 0019 #4 — kontrak `bctone_tenant_config` di CP (= dispatcher 1.4.0) + langkah onboarding. */
import { describe, expect, it } from "vitest";
import { BRIDGE_JOB_TYPES, buildJobFile, idempotencyKey, validateJobRequest } from "@/lib/job-contract";
import { buildOnboardingSteps } from "@/lib/tenant-onboarding";

const req = (args: unknown, slug = "toko-a", dryRun = false) =>
  validateJobRequest("staging", { type: "bctone_tenant_config", slug, env: "staging", dryRun, args });

describe("bctone_tenant_config", () => {
  it("terdaftar sebagai tipe bridge", () => {
    expect(BRIDGE_JOB_TYPES).toContain("bctone_tenant_config");
  });
  it("valid: plan + limits + pack; idempotency per tenant", () => {
    const r = req({ plan: "bctone-umkm", enabled: true, limits: { users: 5, trx_per_month: 5000 }, pack: "fnb" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(idempotencyKey(r.value)).toBe("bctone_tenant_config:toko-a:staging:tenant");
    const f = buildJobFile("staging", {
      id: "3f2c7a9e-1b4d-4e8a-9c3f-5a6b7c8d9e0f",
      type: "bctone_tenant_config",
      slug: "toko-a",
      env: "staging",
      dryRun: false,
      actor: "user:x",
      createdAt: new Date("2026-11-01T00:00:00Z"),
      args: r.value.args,
    });
    expect(f.args).toEqual({ plan: "bctone-umkm", enabled: true, limits: { users: 5, trx_per_month: 5000 }, pack: "fnb" });
  });
  it("ditolak: platform, plan asing, metrik asing, negatif, pack saat disable, limits saat disable", () => {
    expect(req({ plan: "bctone-free", enabled: true }, "platform").ok).toBe(false);
    expect(req({ plan: "odoo-shared-m", enabled: true }).ok).toBe(false);
    expect(req({ plan: "bctone-free", enabled: true, limits: { storage: 1 } }).ok).toBe(false);
    expect(req({ plan: "bctone-free", enabled: true, limits: { users: -1 } }).ok).toBe(false);
    expect(req({ plan: "bctone-free", enabled: true, limits: { users: 1.5 } }).ok).toBe(false);
    expect(req({ plan: "bctone-free", enabled: false, pack: "fnb" }).ok).toBe(false);
    expect(req({ plan: "bctone-free", enabled: false, limits: { users: 1 } }).ok).toBe(false);
    expect(req({ plan: "bctone-free", enabled: true, pack: "tambang" }).ok).toBe(false);
    expect(req({ plan: "bctone-free", enabled: true, pack: "Jasa" }).ok).toBe(false);
    expect(req({ plan: "bctone-free", enabled: true, pack: "jasa" }).ok).toBe(true);
    expect(req({ plan: "bctone-free", enabled: false }).ok).toBe(true);
  });
});

describe("onboarding BCTOne", () => {
  const base = {
    tenantId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    realmEnv: "staging" as const,
    envs: [{ kind: "staging" as const, host: "toko-a.staging.bimacreative.tech" }],
    adminEmail: "owner@toko-a.co.id",
    adminName: "Owner",
  };
  it("tanpa paket BCTOne: rantai lama tidak berubah", () => {
    expect(buildOnboardingSteps(base).map((s) => s.type)).not.toContain("bctone_tenant_config");
  });
  it("paket BCTOne: config tepat setelah DB dibuat", () => {
    const steps = buildOnboardingSteps({ ...base, bctone: { plan: "bctone-free", limits: { users: 1 }, pack: "retail" } });
    const types = steps.map((s) => s.type);
    expect(types.indexOf("bctone_tenant_config")).toBe(types.indexOf("odoo_db_provision") + 1);
    expect(steps.find((s) => s.type === "bctone_tenant_config")!.args).toEqual({ plan: "bctone-free", enabled: true, limits: { users: 1 }, pack: "retail" });
  });
});
