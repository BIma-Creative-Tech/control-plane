import { describe, expect, it } from "vitest";
import { loginUserValues } from "@/db/users";
import { planReconcile, type ReconcileJob } from "@/jobs/reconcile";
import { requiresAdmin } from "@/jobs/service";
import { formToObject, parseForm } from "@/lib/job-forms";
import { parseActionResult, parseJobListParams } from "@/lib/job-list-params";
import { isFetchSiteAllowed, isSameOrigin } from "@/lib/origin";
import { QUOTA, evaluateQuota, type QuotaCounts } from "@/lib/quota";
import { can, primaryRole } from "@/lib/roles";

const ENV_ID = "11111111-1111-4111-8111-111111111111";
const fd = (o: Record<string, string>) => Object.entries(o) as [string, string][];

describe("otorisasi job (plan 05 §5.1, iterasi 1)", () => {
  it("jobs:view/jobs:odoo hanya superadmin+ops; jobs:odoo_admin hanya superadmin", () => {
    for (const r of ["client_admin", "client_user"] as const) {
      expect(can([r], "jobs:view")).toBe(false);
      expect(can([r], "jobs:odoo")).toBe(false);
      expect(can([r], "jobs:odoo_admin")).toBe(false);
    }
    expect(can(["ops"], "jobs:odoo")).toBe(true);
    expect(can(["ops"], "jobs:odoo_admin")).toBe(false);
    expect(can(["superadmin"], "jobs:odoo_admin")).toBe(true);
  });

  it("aksi berisiko wajib admin: route remove, sso disable, rotate_secret", () => {
    expect(requiresAdmin("odoo_route", { remove: true })).toBe(true);
    expect(requiresAdmin("odoo_route", { remove: false })).toBe(false);
    expect(requiresAdmin("odoo_sso_disable", { hosts: [] })).toBe(true);
    expect(requiresAdmin("odoo_sso_provision", { rotate_secret: true })).toBe(true);
    expect(requiresAdmin("odoo_sso_provision", { rotate_secret: false })).toBe(false);
    expect(requiresAdmin("odoo_sso_user", { action: "revoke" })).toBe(false);
    expect(requiresAdmin("odoo_db_provision", {})).toBe(false);
  });

  it("primaryRole memilih role tertinggi", () => {
    expect(primaryRole(["client_user", "ops"])).toBe("ops");
    expect(primaryRole([])).toBe("client_user");
  });
});

describe("Origin (CSRF, fail-closed)", () => {
  const app = "https://cp.bimacreative.tech";
  it.each([
    [null, false],
    ["null", false],
    ["", false],
    ["https://cp.bimacreative.tech", true],
    ["https://cp.bimacreative.tech/", true],
    ["http://cp.bimacreative.tech", false],
    ["https://cp.bimacreative.tech.evil.com", false],
    ["https://cp.staging.bimacreative.tech", false],
    ["https://cp.bimacreative.tech:8443", false],
    ["https://cp.bimacreative.tech/path", false],
  ])("origin %j → %s", (o, ok) => {
    expect(isSameOrigin(o, app)).toBe(ok);
  });
  it("Sec-Fetch-Site", () => {
    expect(isFetchSiteAllowed("same-origin")).toBe(true);
    expect(isFetchSiteAllowed("cross-site")).toBe(false);
    expect(isFetchSiteAllowed("same-site")).toBe(false);
    expect(isFetchSiteAllowed(null)).toBe(true);
  });
});

describe("kuota (sama dengan dispatcher)", () => {
  const zero: QuotaCounts = { totalLastHour: 0, dbProvisionLastDay: 0, ssoUserLastHour: 0, rotateSecretLastDay: 0, actorLastMinute: 0 };
  it("di bawah batas → null", () => {
    expect(evaluateQuota(zero, { type: "odoo_db_provision", rotateSecret: false })).toBeNull();
  });
  it.each([
    [{ actorLastMinute: QUOTA.perActorPerMinute }, "odoo_route", false, "actor_rate"],
    [{ totalLastHour: 60 }, "odoo_route", false, "total_hour"],
    [{ dbProvisionLastDay: 3 }, "odoo_db_provision", false, "db_provision_day"],
    [{ ssoUserLastHour: 30 }, "odoo_sso_user", false, "sso_user_hour"],
    [{ rotateSecretLastDay: 5 }, "odoo_sso_provision", true, "rotate_secret_day"],
  ] as const)("%j %s → %s", (patch, type, rotate, expected) => {
    expect(evaluateQuota({ ...zero, ...patch }, { type, rotateSecret: rotate })).toBe(expected);
  });
  it("kuota tipe lain tidak memblokir", () => {
    expect(evaluateQuota({ ...zero, dbProvisionLastDay: 3, rotateSecretLastDay: 5 }, { type: "odoo_route", rotateSecret: false })).toBeNull();
  });
});

describe("form Server Action (Zod strict)", () => {
  it("ssoUser: normalisasi email huruf kecil, checkbox → boolean, login kosong → undefined", () => {
    const r = parseForm("ssoUser", fd({ environmentId: ENV_ID, action: "grant", email: " A@B.co ", login: "", create_kc: "on" }));
    expect(r.success && r.data).toEqual({
      environmentId: ENV_ID,
      action: "grant",
      email: "a@b.co",
      login: undefined,
      admin: false,
      create_kc: true,
      dry_run: false,
    });
  });
  it.each([
    ["field tak dikenal", { environmentId: ENV_ID, host: "", extra: "x" }],
    ["environmentId bukan uuid", { environmentId: "1 OR 1=1" }],
    ["host injeksi", { environmentId: ENV_ID, host: "--remove" }],
  ])("dbProvision menolak %s", (_n, o) => {
    expect(parseForm("dbProvision", fd(o)).success).toBe(false);
  });
  it("field ganda / File ditolak; field internal $ACTION dibuang", () => {
    expect(formToObject([["a", "1"], ["a", "2"]])).toBeNull();
    expect(formToObject([["f", new Blob(["x"]) as unknown as File]])).toBeNull();
    expect(formToObject([["$ACTION_ID_abc", ""], ["jobId", "x"]])).toEqual({ jobId: "x" });
  });
  it("login diawali '-' ditolak", () => {
    expect(parseForm("ssoUser", fd({ environmentId: ENV_ID, action: "grant", email: "a@b.co", login: "-x" })).success).toBe(false);
  });
  it("kode hasil & filter daftar job hanya whitelist", () => {
    expect(parseActionResult("queued")).toBe("queued");
    expect(parseActionResult("<script>")).toBeNull();
    expect(parseJobListParams({ status: "bogus", type: "odoo_route", client: "ACME", page: "-1" })).toEqual({
      client: undefined,
      status: undefined,
      type: "odoo_route",
      page: 1,
    });
  });
});

describe("rekonsiliasi hasil → environment / tenant_user_access", () => {
  const base: ReconcileJob = {
    id: "22222222-2222-4222-8222-222222222222",
    type: "odoo_db_provision",
    env: "prod",
    dryRun: false,
    args: {},
    status: "succeeded",
    result: { db: "acme_co_prod", changed: "1" },
  };
  const env = { dbName: "acme_co_prod" };
  it("db_provision: db cocok → provisioned; tidak cocok → peringatan", () => {
    expect(planReconcile(base, env).env).toEqual({ dbStatus: "provisioned" });
    expect(planReconcile({ ...base, result: { db: "other_prod" } }, env).warnings.length).toBe(1);
  });
  it("route render/remove", () => {
    const r = planReconcile({ ...base, type: "odoo_route", args: { remove: false }, result: { host: "acme-co.erp.bimacreative.tech" } }, env);
    expect(r.env).toEqual({ routeStatus: "active", host: "acme-co.erp.bimacreative.tech" });
    expect(planReconcile({ ...base, type: "odoo_route", args: { remove: true }, result: { host: "-" } }, env).env).toEqual({ routeStatus: "removed" });
    // host dari hasil yang tidak sesuai env diabaikan
    expect(planReconcile({ ...base, type: "odoo_route", args: { remove: false }, result: { host: "evil.example" } }, env).env).toEqual({});
  });
  it("sso_provision: client/provider dari RESULT; dry-run tidak mengubah apa pun", () => {
    const res = { client: "odoo-acme-co-prod", provider: "7", changed: "3" };
    expect(planReconcile({ ...base, type: "odoo_sso_provision", result: res }, env).env).toEqual({
      ssoStatus: "active",
      ssoClientId: "odoo-acme-co-prod",
      ssoProviderId: 7,
    });
    expect(planReconcile({ ...base, type: "odoo_sso_provision", dryRun: true, result: res }, env).env).toEqual({});
    expect(planReconcile({ ...base, type: "odoo_sso_provision", result: { ...res, mode: "dry-run" } }, env).env).toEqual({});
  });
  it("sso_user grant/revoke/gagal", () => {
    const g = planReconcile(
      {
        ...base,
        type: "odoo_sso_user",
        args: { action: "grant", email: "a@b.co" },
        result: { kc_user: "33333333-3333-4333-8333-333333333333", odoo_user: "12", action: "grant", changed: "2" },
      },
      env,
    );
    expect(g.tenantUser).toEqual({
      email: "a@b.co",
      set: { status: "active", kcUserId: "33333333-3333-4333-8333-333333333333", odooUserId: 12 },
    });
    expect(planReconcile({ ...base, type: "odoo_sso_user", args: { action: "revoke", email: "a@b.co" }, result: { kc_user: "-", action: "revoke" } }, env).tenantUser).toEqual({
      email: "a@b.co",
      set: { status: "revoked" },
    });
    expect(planReconcile({ ...base, type: "odoo_sso_user", status: "failed", args: { action: "grant", email: "a@b.co" }, result: {} }, env).tenantUser).toEqual({
      email: "a@b.co",
      set: { status: "failed" },
      onlyIfPending: true,
    });
  });
});

describe("upsert users saat login", () => {
  it("email huruf kecil, nama dipotong, role tertinggi", () => {
    const v = loginUserValues({ sub: "s1", email: "Ops@Example.COM", name: "x".repeat(300), roles: ["ops", "client_user"] }, new Date(0));
    expect(v).toMatchObject({ keycloakSub: "s1", email: "ops@example.com", role: "ops" });
    expect(v.displayName?.length).toBe(200);
    expect(loginUserValues({ sub: "s2", email: 5, roles: [] }, new Date(0))).toMatchObject({ email: null, role: "client_user" });
  });
});
