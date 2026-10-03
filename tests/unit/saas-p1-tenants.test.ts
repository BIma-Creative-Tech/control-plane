/**
 * SaaS Fase 1 W5 — Tenant: komposisi rantai onboarding (urutan + args persis per instance), validasi form (slug, host
 * per aturan HOST job-contract), rantai dengan tipe lama, ulangi dari langkah gagal, suspend/resume, keputusan
 * approve kc_realm_sync, filter audit + redaksi email, kode umpan balik, kuota, izin.
 */
import { describe, expect, it } from "vitest";
import { MAX_CHAIN_STEPS, chainRouteHosts, validateChain } from "@/jobs/chain";
import { tenantOutcomeCode, type TenantActionOutcome } from "@/jobs/tenants";
import { auditPageHref, parseAuditParams, redactAuditMetadata } from "@/lib/audit-params";
import { BRIDGE_JOB_TYPES, LEGACY_JOB_TYPES, SAAS_P1_JOB_TYPES, idempotencyKey, validateJobRequest } from "@/lib/job-contract";
import { ACTION_RESULT_CODES, ACTION_RESULT_TEXT } from "@/lib/job-list-params";
import { P1_QUOTA, evaluateChainQuota, type ChainQuotaCounts } from "@/lib/quota";
import { PERMISSIONS, can } from "@/lib/roles";
import {
  ONBOARDING_TYPES,
  REALM_PLAN_MAX_AGE_MS,
  buildOnboardingSteps,
  buildTenantStateSteps,
  confirmMatches,
  decideRealmSync,
  environmentRowValues,
  onboardingInvalidFields,
  parseOnboardingForm,
  parseTenantForm,
  realmNameForEnv,
  retryStepsFrom,
  retryableOrigin,
  typesEnabled,
  type RetryChainRow,
} from "@/lib/tenant-onboarding";

const TID = "11111111-1111-4111-8111-111111111111";
const entries = (o: Record<string, string>) => Object.entries(o) as [string, string][];
const base = { slug: "acme-co", name: "PT Acme", admin_email: "Admin@Acme.co.id", admin_name: "Budi Santoso" };

describe("onboarding: komposisi rantai (urutan + args persis)", () => {
  it("prod-inst, prod saja: 8 langkah", () => {
    const steps = buildOnboardingSteps({
      tenantId: TID,
      realmEnv: "prod",
      envs: [{ kind: "prod", host: "acme-co.erp.bimacreative.tech" }],
      adminEmail: "admin@acme.co.id",
      adminName: "Budi Santoso",
    });
    expect(steps).toEqual([
      { type: "kc_org_ensure", env: "prod", args: { tenant_id: TID } },
      { type: "odoo_db_provision", env: "prod", args: { host: "acme-co.erp.bimacreative.tech" } },
      { type: "odoo_route", env: "prod", args: { host: "acme-co.erp.bimacreative.tech", remove: false } },
      { type: "odoo_sso_provision", env: "prod", args: { hosts: ["acme-co.erp.bimacreative.tech"], rotate_secret: false, skip_smoke: false } },
      { type: "odoo_tenant_config", env: "prod", args: { tenant_check: "compat" } },
      { type: "kc_user_ensure", env: "prod", args: { email: "admin@acme.co.id", tenant_id: TID, invite: true, name: "Budi Santoso" } },
      { type: "kc_user_set_roles", env: "prod", args: { email: "admin@acme.co.id", cp_role: "client_admin", odoo: "admin" } },
      { type: "odoo_user_ensure", env: "prod", args: { email: "admin@acme.co.id", role: "admin", active: true, name: "Budi Santoso" } },
    ]);
    expect(validateChain("prod", BRIDGE_JOB_TYPES, "acme-co", steps).ok).toBe(true);
  });

  it("prod-inst, prod + demo: 14 langkah, env per langkah, set_roles/odoo_user satu per env, lolos kontrak", () => {
    const steps = buildOnboardingSteps({
      tenantId: TID,
      realmEnv: "prod",
      envs: [
        { kind: "prod", host: "acme-co.erp.bimacreative.tech" },
        { kind: "demo", host: "acme-demo.erp.bimacreative.tech" },
      ],
      adminEmail: "admin@acme.co.id",
      adminName: null,
    });
    expect(steps.map((s) => `${s.type}@${s.env}`)).toEqual([
      "kc_org_ensure@prod",
      "odoo_db_provision@prod",
      "odoo_route@prod",
      "odoo_sso_provision@prod",
      "odoo_tenant_config@prod",
      "odoo_db_provision@demo",
      "odoo_route@demo",
      "odoo_sso_provision@demo",
      "odoo_tenant_config@demo",
      "kc_user_ensure@prod",
      "kc_user_set_roles@prod",
      "kc_user_set_roles@demo",
      "odoo_user_ensure@prod",
      "odoo_user_ensure@demo",
    ]);
    expect(steps.find((s) => s.type === "kc_user_ensure")!.args).toEqual({ email: "admin@acme.co.id", tenant_id: TID, invite: true });
    expect(steps.filter((s) => s.type === "odoo_db_provision").map((s) => s.args)).toEqual([
      { host: "acme-co.erp.bimacreative.tech" },
      { host: "acme-demo.erp.bimacreative.tech" },
    ]);
    expect(steps.length).toBeLessThanOrEqual(MAX_CHAIN_STEPS);
    const v = validateChain("prod", BRIDGE_JOB_TYPES, "acme-co", steps);
    expect(v.ok).toBe(true);
    // Hanya tipe Fase 1 yang memegang idempotency_key; tipe lama → indeks (environment, type).
    if (v.ok) {
      expect(v.reqs.map((r) => idempotencyKey(r))).toEqual([
        "kc_org_ensure:acme-co:prod:org",
        null,
        null,
        null,
        "odoo_tenant_config:acme-co:prod:tenant",
        null,
        null,
        null,
        "odoo_tenant_config:acme-co:demo:tenant",
        "kc_user_ensure:acme-co:prod:admin@acme.co.id",
        "kc_user_set_roles:acme-co:prod:admin@acme.co.id",
        "kc_user_set_roles:acme-co:demo:admin@acme.co.id",
        "odoo_user_ensure:acme-co:prod:admin@acme.co.id",
        "odoo_user_ensure:acme-co:demo:admin@acme.co.id",
      ]);
      // Host SSO ⊆ host route yang dibuat rantai itu sendiri (env yang sama).
      expect(chainRouteHosts(v.reqs, 3).get("prod")).toBe("acme-co.erp.bimacreative.tech");
      expect(chainRouteHosts(v.reqs, 3).get("demo")).toBeUndefined();
      expect(chainRouteHosts(v.reqs, 7).get("demo")).toBe("acme-demo.erp.bimacreative.tech");
    }
  });

  it("staging-inst: realm env staging, 8 langkah, ditolak di instance prod", () => {
    const steps = buildOnboardingSteps({
      tenantId: TID,
      realmEnv: "staging",
      envs: [{ kind: "staging", host: "acme-co.staging.bimacreative.tech" }],
      adminEmail: "admin@acme.co.id",
      adminName: "Budi",
    });
    expect(steps.map((s) => `${s.type}@${s.env}`)).toEqual([
      "kc_org_ensure@staging",
      "odoo_db_provision@staging",
      "odoo_route@staging",
      "odoo_sso_provision@staging",
      "odoo_tenant_config@staging",
      "kc_user_ensure@staging",
      "kc_user_set_roles@staging",
      "odoo_user_ensure@staging",
    ]);
    expect(validateChain("staging", BRIDGE_JOB_TYPES, "acme-co", steps).ok).toBe(true);
    expect(validateChain("prod", BRIDGE_JOB_TYPES, "acme-co", steps)).toMatchObject({ ok: false, issue: "env_instance" });
    // Instance tanpa tipe baru (allowlist default 5 tipe lama) → kc_org_ensure ditolak.
    expect(validateChain("staging", LEGACY_JOB_TYPES, "acme-co", steps)).toMatchObject({ ok: false, issue: "type_not_allowed", step: 0 });
    expect(typesEnabled(LEGACY_JOB_TYPES, ONBOARDING_TYPES)).toBe(false);
    expect(typesEnabled(BRIDGE_JOB_TYPES, ONBOARDING_TYPES)).toBe(true);
  });

  it("environmentRowValues = logika Tambah environment (pool, db, url)", () => {
    expect(environmentRowValues("acme-co", "prod", "acme-co.erp.bimacreative.tech")).toEqual({
      kind: "prod",
      odooInstance: "pool-a",
      dbName: "acme_co_prod",
      url: "https://acme-co.erp.bimacreative.tech",
    });
    expect(environmentRowValues("acme-co", "staging", "x.staging.bimacreative.tech").odooInstance).toBe("staging");
  });
});

describe("rantai: tipe lama & dry-run", () => {
  it("tipe lama di luar CHAIN_ENV_TYPES (sso_user, sso_disable) tidak boleh masuk rantai", () => {
    expect(
      validateChain("prod", BRIDGE_JOB_TYPES, "acme-co", [
        { type: "odoo_sso_user", env: "prod", args: { action: "grant", email: "a@acme.co.id", admin: false, create_kc: false } },
      ]),
    ).toEqual({ ok: false, issue: "type_not_allowed", step: 0 });
    expect(
      validateChain("prod", BRIDGE_JOB_TYPES, "acme-co", [{ type: "odoo_sso_disable", env: "prod", args: { hosts: ["acme-co.erp.bimacreative.tech"] } }]),
    ).toEqual({ ok: false, issue: "type_not_allowed", step: 0 });
  });

  it("aturan host kontrak tetap berlaku di rantai (demo tanpa host, host staging di prod)", () => {
    expect(validateChain("prod", BRIDGE_JOB_TYPES, "acme-co", [{ type: "odoo_db_provision", env: "demo", args: {} }])).toMatchObject({
      ok: false,
      issue: "host_required",
    });
    expect(
      validateChain("prod", BRIDGE_JOB_TYPES, "acme-co", [{ type: "odoo_route", env: "prod", args: { host: "acme.staging.bimacreative.tech", remove: false } }]),
    ).toMatchObject({ ok: false, issue: "host_env" });
  });

  it("dry-run per langkah (rencana kc_realm_sync) + batas MAX_CHAIN_STEPS", () => {
    const v = validateChain("prod", BRIDGE_JOB_TYPES, "platform", [{ type: "kc_realm_sync", env: "prod", args: {}, dryRun: true }]);
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.reqs[0]!.dryRun).toBe(true);
      expect(idempotencyKey(v.reqs[0]!)).toBeNull();
    }
    // Apply prod tanpa approve ditolak kontrak (lapisan kedua di bawah decideRealmSync).
    expect(validateChain("prod", BRIDGE_JOB_TYPES, "platform", [{ type: "kc_realm_sync", env: "prod", args: {} }])).toMatchObject({
      ok: false,
      issue: "approve_required",
    });
    const many = Array.from({ length: MAX_CHAIN_STEPS + 1 }, () => ({ type: "tenant_resume" as const, env: "prod" as const, args: {} }));
    expect(validateChain("prod", BRIDGE_JOB_TYPES, "acme-co", many)).toMatchObject({ ok: false, issue: "args" });
  });

  it("chainRouteHosts: route remove menghapus host terencana; tanpa host → host default skrip", () => {
    const reqs = [
      { type: "odoo_route", slug: "acme-co", env: "prod", dryRun: false, args: { remove: false } },
      { type: "odoo_route", slug: "acme-co", env: "staging", dryRun: false, args: { host: "a.staging.bimacreative.tech", remove: false } },
      { type: "odoo_route", slug: "acme-co", env: "staging", dryRun: false, args: { remove: true } },
    ] as Parameters<typeof chainRouteHosts>[0];
    expect(chainRouteHosts(reqs, 3).get("prod")).toBe("acme-co.erp.bimacreative.tech");
    expect(chainRouteHosts(reqs, 3).has("staging")).toBe(false);
    expect(chainRouteHosts(reqs, 2).get("staging")).toBe("a.staging.bimacreative.tech");
  });
});

describe("form onboarding (slug, host per aturan HOST)", () => {
  it("prod-inst valid: email dinormalisasi, host default, brand opsional", () => {
    const r = parseOnboardingForm("prod", entries({ ...base, brand: "", prod_host: "" }));
    expect(r).toEqual({
      success: true,
      data: {
        slug: "acme-co",
        name: "PT Acme",
        brand: null,
        adminEmail: "admin@acme.co.id",
        adminName: "Budi Santoso",
        envs: [{ kind: "prod", host: "acme-co.erp.bimacreative.tech" }],
        planId: null,
      },
    });
  });

  it("prod + demo dengan host; override host prod", () => {
    const r = parseOnboardingForm(
      "prod",
      entries({ ...base, brand: "Acme", prod_host: "erp-acme.erp.bimacreative.tech", demo: "on", demo_host: "ACME-demo.erp.bimacreative.tech" }),
    );
    expect(r.success && r.data.envs).toEqual([
      { kind: "prod", host: "erp-acme.erp.bimacreative.tech" },
      { kind: "demo", host: "acme-demo.erp.bimacreative.tech" },
    ]);
    expect(r.success && r.data.brand).toBe("Acme");
  });

  it.each([
    [{ slug: "platform" }, "slug_reserved"],
    [{ slug: "Acme" }, "invalid"],
    [{ slug: "ab" }, "invalid"],
    [{ slug: "acme_co" }, "invalid"],
    [{ admin_email: "bukan-email" }, "invalid"],
    [{ admin_name: "Budi Śantoso" }, "name_invalid"],
    [{ admin_name: "-budi" }, "name_invalid"],
    [{ name: "" }, "invalid"],
    [{ prod_host: "acme.staging.bimacreative.tech" }, "host_invalid"],
    [{ prod_host: "acme.example.com" }, "host_invalid"],
    [{ prod_host: "a.b.erp.bimacreative.tech" }, "host_invalid"],
    [{ prod_host: "acme..erp.bimacreative.tech" }, "invalid"],
    [{ demo: "on" }, "host_invalid"],
    [{ demo: "on", demo_host: "acme-co.erp.bimacreative.tech" }, "host_invalid"],
    [{ demo_host: "acme-demo.erp.bimacreative.tech" }, "invalid"],
    [{ staging_host: "acme.staging.bimacreative.tech" }, "invalid"],
    [{ extra: "x" }, "invalid"],
  ] as [Record<string, string>, string][])("prod-inst %j → %s", (patch, issue) => {
    expect(parseOnboardingForm("prod", entries({ ...base, ...patch }))).toEqual({ success: false, issue });
  });

  it("onboardingInvalidFields: nama field gagal (tanpa nilai), kunci asing berawalan +", () => {
    expect(onboardingInvalidFields("staging", entries(base))).toEqual([]);
    expect(onboardingInvalidFields("staging", entries({ ...base, slug: "-acme" }))).toEqual(["slug"]);
    expect(onboardingInvalidFields("staging", entries({ ...base, staging_host: "https://acme.staging.bimacreative.tech/" }))).toEqual(["staging_host"]);
    expect(onboardingInvalidFields("staging", entries({ ...base, prod_host: "" }))).toEqual(["+prod_host"]);
    expect(onboardingInvalidFields("prod", entries({ ...base, admin_email: "Bukan Email" }))).toEqual(["admin_email"]);
  });

  it("staging-inst: hanya env staging; host harus *.staging.bimacreative.tech; field prod/demo ditolak", () => {
    expect(parseOnboardingForm("staging", entries(base))).toMatchObject({
      success: true,
      data: { envs: [{ kind: "staging", host: "acme-co.staging.bimacreative.tech" }] },
    });
    expect(parseOnboardingForm("staging", entries({ ...base, staging_host: "acme.erp.bimacreative.tech" }))).toEqual({ success: false, issue: "host_invalid" });
    expect(parseOnboardingForm("staging", entries({ ...base, prod_host: "" }))).toEqual({ success: false, issue: "invalid" });
    expect(parseOnboardingForm("staging", entries({ ...base, demo: "on" }))).toEqual({ success: false, issue: "invalid" });
  });

  it("field ganda / File ditolak (formToObject)", () => {
    expect(parseOnboardingForm("prod", [...entries(base), ["slug", "beta-co"]])).toEqual({ success: false, issue: "invalid" });
  });
});

describe("suspend/resume + konfirmasi", () => {
  it("satu langkah per env instance; args kosong; idempotency per env", () => {
    const s = buildTenantStateSteps("suspend", [{ kind: "prod" }, { kind: "demo" }]);
    expect(s).toEqual([
      { type: "tenant_suspend", env: "prod", args: {} },
      { type: "tenant_suspend", env: "demo", args: {} },
    ]);
    expect(buildTenantStateSteps("resume", [{ kind: "staging" }])).toEqual([{ type: "tenant_resume", env: "staging", args: {} }]);
    const v = validateChain("prod", BRIDGE_JOB_TYPES, "acme-co", s);
    expect(v.ok && v.reqs.map((r) => idempotencyKey(r))).toEqual(["tenant_suspend:acme-co:prod:tenant", "tenant_suspend:acme-co:demo:tenant"]);
    // Tenant platform tidak bisa disuspend (kontrak §1).
    expect(validateChain("prod", BRIDGE_JOB_TYPES, "platform", s)).toMatchObject({ ok: false, issue: "platform_forbidden" });
  });

  it("konfirmasi ketik slug: persis (trim saja), bukan prefix/huruf besar/kosong", () => {
    expect(confirmMatches("acme-co", "acme-co")).toBe(true);
    expect(confirmMatches("  acme-co ", "acme-co")).toBe(true);
    for (const bad of ["", "acme", "ACME-CO", "acme-co2", null, undefined]) expect(confirmMatches(bad, "acme-co")).toBe(false);
    expect(confirmMatches("", "")).toBe(false);
  });

  it("form suspend/resume: .strict(), action enum", () => {
    const C = "11111111-1111-4111-8111-111111111111";
    expect(parseTenantForm("tenantState", entries({ clientId: C, action: "suspend", confirm: "acme-co" })).success).toBe(true);
    expect(parseTenantForm("tenantState", entries({ clientId: C, action: "terminate", confirm: "acme-co" })).success).toBe(false);
    expect(parseTenantForm("tenantState", entries({ clientId: "x", action: "resume", confirm: "acme-co" })).success).toBe(false);
    expect(parseTenantForm("tenantState", entries({ clientId: C, action: "resume", confirm: "acme-co", env: "prod" })).success).toBe(false);
    expect(parseTenantForm("realmApply", entries({ confirm: "platform", approve: "on" }))).toEqual({ success: true, data: { confirm: "platform", approve: true } });
    expect(parseTenantForm("realmApply", entries({ confirm: "platform" }))).toEqual({ success: true, data: { confirm: "platform", approve: false } });
    expect(parseTenantForm("realmPlan", entries({ dry_run: "false" })).success).toBe(false);
  });
});

describe("ulangi rantai dari langkah gagal", () => {
  const row = (id: string, type: string, status: string, errorCode: string | null = null): RetryChainRow => ({
    id,
    type,
    env: "prod",
    status,
    errorCode,
    dryRun: false,
    args: { n: id },
  });
  const chain = [
    row("a", "kc_org_ensure", "succeeded"),
    row("b", "odoo_db_provision", "succeeded"),
    row("c", "odoo_route", "failed", "script_exit"),
    row("d", "odoo_sso_provision", "cancelled", "chain_aborted"),
    row("e", "odoo_tenant_config", "cancelled", "chain_aborted"),
  ];

  it("dari langkah gagal: langkah itu + sesudahnya, args sama", () => {
    expect(retryStepsFrom(chain, "c")).toEqual({
      ok: true,
      steps: [
        { type: "odoo_route", env: "prod", args: { n: "c" } },
        { type: "odoo_sso_provision", env: "prod", args: { n: "d" } },
        { type: "odoo_tenant_config", env: "prod", args: { n: "e" } },
      ],
    });
  });

  it("bukan langkah gagal / chain_aborted / langkah sukses / tidak ada → ditolak", () => {
    expect(retryStepsFrom(chain, "b")).toEqual({ ok: false, issue: "not_failed" });
    expect(retryStepsFrom(chain, "d")).toEqual({ ok: false, issue: "not_failed" });
    expect(retryStepsFrom(chain, "zz")).toEqual({ ok: false, issue: "not_in_chain" });
  });

  it("langkah sebelumnya belum sukses / masih ada langkah aktif → ditolak", () => {
    const twoFails = [row("a", "kc_org_ensure", "failed"), row("b", "odoo_db_provision", "failed")];
    expect(retryStepsFrom(twoFails, "b")).toEqual({ ok: false, issue: "earlier_unfinished" });
    const active = [row("a", "kc_org_ensure", "succeeded"), row("b", "odoo_route", "failed"), row("c", "odoo_tenant_config", "queued")];
    expect(retryStepsFrom(active, "b")).toEqual({ ok: false, issue: "chain_active" });
  });

  it("asal rantai yang boleh diulang: onboarding saja (Users, realm sync N1, suspend/resume N3 tidak)", () => {
    for (const a of ["tenant.onboard", "chain.retry"]) expect(retryableOrigin(a)).toBe(true);
    for (const a of ["realm.sync_plan", "realm.sync_apply", "tenant.suspend", "tenant.resume"]) expect(retryableOrigin(a)).toBe(false);
    for (const a of ["user.add", "user.disable", "user.adopt", "user.change_access", "test.chain", "", null, undefined]) expect(retryableOrigin(a)).toBe(false);
  });

  it("cancelled manual (bukan chain_aborted) boleh diulang; dry-run dipertahankan", () => {
    const r = retryStepsFrom([{ ...row("x", "kc_realm_sync", "cancelled", null), dryRun: true, args: {} }], "x");
    expect(r).toEqual({ ok: true, steps: [{ type: "kc_realm_sync", env: "prod", args: {}, dryRun: true }] });
  });
});

describe("kc_realm_sync: keputusan approve", () => {
  const now = new Date("2026-10-03T12:00:00Z");
  const okPlan = { status: "succeeded", finishedAt: new Date("2026-10-03T11:00:00Z"), result: { realm: "platform", changed: "3", mode: "plan", blockers: "0" } };

  it("nama realm per env", () => {
    expect(realmNameForEnv("prod")).toBe("platform");
    expect(realmNameForEnv("demo")).toBe("platform");
    expect(realmNameForEnv("staging")).toBe("platform-staging");
  });

  it("rencana = dry-run tanpa args", () => {
    expect(decideRealmSync({ realmEnv: "prod", mode: "plan", lastPlan: null, now })).toEqual({
      ok: true,
      step: { type: "kc_realm_sync", env: "prod", args: {}, dryRun: true },
    });
  });

  it("apply prod: wajib ketik realm, checkbox persetujuan, rencana segar tanpa blocker → approve=true", () => {
    const d = (p: Partial<Parameters<typeof decideRealmSync>[0]>) =>
      decideRealmSync({ realmEnv: "prod", mode: "apply", confirmRealm: "platform", approveChecked: true, lastPlan: okPlan, now, ...p });
    expect(d({})).toEqual({ ok: true, step: { type: "kc_realm_sync", env: "prod", args: { approve: true } } });
    expect(d({ confirmRealm: "platform-staging" })).toEqual({ ok: false, code: "confirm" });
    expect(d({ confirmRealm: null })).toEqual({ ok: false, code: "confirm" });
    expect(d({ approveChecked: false })).toEqual({ ok: false, code: "approve_required" });
    expect(d({ approveChecked: undefined })).toEqual({ ok: false, code: "approve_required" });
    expect(d({ lastPlan: null })).toEqual({ ok: false, code: "plan_required" });
    expect(d({ lastPlan: { ...okPlan, status: "failed" } })).toEqual({ ok: false, code: "plan_required" });
    expect(d({ lastPlan: { ...okPlan, status: "running", finishedAt: null } })).toEqual({ ok: false, code: "plan_required" });
    expect(d({ lastPlan: { ...okPlan, result: { ...okPlan.result, blockers: "1" } } })).toEqual({ ok: false, code: "plan_required" });
    // N7: RESULT tanpa `blockers` / result null → tidak bersih (fail-closed).
    expect(d({ lastPlan: { ...okPlan, result: { realm: "platform", changed: "3", mode: "plan" } } })).toEqual({ ok: false, code: "plan_required" });
    expect(d({ lastPlan: { ...okPlan, result: null } })).toEqual({ ok: false, code: "plan_required" });
    expect(d({ lastPlan: { ...okPlan, result: { ...okPlan.result, blockers: "" } } })).toEqual({ ok: false, code: "plan_required" });
    expect(d({ lastPlan: { ...okPlan, finishedAt: new Date(now.getTime() - REALM_PLAN_MAX_AGE_MS - 1000) } })).toEqual({ ok: false, code: "plan_required" });
    // Hasil keputusan lolos kontrak (approve wajib di prod).
    const ok = d({});
    if (ok.ok) expect(validateJobRequest("prod", { type: "kc_realm_sync", slug: "platform", env: "prod", dryRun: false, args: ok.step.args }).ok).toBe(true);
  });

  it("apply staging: tidak pernah mengirim approve walau checkbox dicentang; realm platform-staging", () => {
    const base2 = { realmEnv: "staging" as const, mode: "apply" as const, lastPlan: okPlan, now };
    expect(decideRealmSync({ ...base2, confirmRealm: "platform-staging", approveChecked: true })).toEqual({
      ok: true,
      step: { type: "kc_realm_sync", env: "staging", args: {} },
    });
    expect(decideRealmSync({ ...base2, confirmRealm: "platform-staging", approveChecked: false }).ok).toBe(true);
    expect(decideRealmSync({ ...base2, confirmRealm: "platform" })).toEqual({ ok: false, code: "confirm" });
  });
});

describe("audit: filter + redaksi email", () => {
  it("nilai valid diterima; aktor tanpa awalan → user:<prefix>; rentang inklusif", () => {
    const p = parseAuditParams({ actor: "6b1f0e2a", tenant: "acme-co", action: "tenant.", result: "rejected", from: "2026-10-01", to: "2026-10-03", page: "2" });
    expect(p.actorPrefix).toBe("user:6b1f0e2a");
    expect(p.tenant).toBe("acme-co");
    expect(p.actionPrefix).toBe("tenant.");
    expect(p.result).toBe("rejected");
    // N10: hari kalender WIB → 00:00 WIB = 17:00 UTC hari sebelumnya.
    expect(p.from?.toISOString()).toBe("2026-09-30T17:00:00.000Z");
    expect(p.toExclusive?.toISOString()).toBe("2026-10-03T17:00:00.000Z");
    expect(p.page).toBe(2);
    expect(auditPageHref(p, 3)).toBe("/audit?actor=6b1f0e2a&tenant=acme-co&action=tenant.&result=rejected&from=2026-10-01&to=2026-10-03&page=3");
    expect(parseAuditParams({ actor: "system:worker" }).actorPrefix).toBe("system:worker");
  });

  it("nilai tak valid diabaikan (tanpa wildcard/injeksi), tanggal tak ada → diabaikan, rentang terbalik ditukar", () => {
    const p = parseAuditParams({ actor: "user:%", tenant: "ACME", action: "Tenant'; drop", result: "ok", from: "2026-02-30", to: "x", page: "-1" });
    expect(p).toEqual({ page: 1, raw: {} });
    expect(parseAuditParams({ actor: "a b" }).actorPrefix).toBeUndefined();
    const sw = parseAuditParams({ from: "2026-10-05", to: "2026-10-01" });
    expect(sw.from?.toISOString()).toBe("2026-09-30T17:00:00.000Z");
    expect(sw.toExclusive?.toISOString()).toBe("2026-10-05T17:00:00.000Z");
    expect(sw.raw).toEqual({ from: "2026-10-01", to: "2026-10-05" });
    expect(parseAuditParams({ page: ["4", "5"] }).page).toBe(4);
  });

  it("redaksi: email di string/nested/array + kunci email/login → [email]; email_hash tetap", () => {
    const md = {
      email_hash: "ab12",
      email: "budi@acme.co.id",
      note: "undang Budi@Acme.co.id ke tenant",
      nested: { list: ["x@y.io", "aman"], login: "budi" },
      count: 3,
    };
    const r = redactAuditMetadata(md) as Record<string, unknown>;
    expect(r).toEqual({
      email_hash: "ab12",
      email: "[email]",
      note: "undang [email] ke tenant",
      nested: { list: ["[email]", "aman"], login: "[email]" },
      count: 3,
    });
    expect(JSON.stringify(r)).not.toMatch(/@/);
  });
});

describe("kode umpan balik, kuota, izin", () => {
  it("tenantOutcomeCode: setiap kode ada di whitelist + teks", () => {
    const cases: [TenantActionOutcome, string][] = [
      [{ ok: true, chainId: "c", jobIds: [], clientId: "x" }, "queued"],
      [{ ok: false, reason: "forbidden" }, "forbidden"],
      [{ ok: false, reason: "adopt_forbidden" }, "forbidden"],
      [{ ok: false, reason: "confirm" }, "confirm"],
      [{ ok: false, reason: "exists" }, "exists"],
      [{ ok: false, reason: "binding", conflict: "email_other_tenant" }, "email_other_tenant"],
      [{ ok: false, reason: "binding", conflict: "email_unbound" }, "email_unbound"],
      [{ ok: false, reason: "realm", code: "approve_required" }, "approve_required"],
      [{ ok: false, reason: "realm", code: "plan_required" }, "plan_required"],
      [{ ok: false, reason: "precondition", detail: "host_taken" }, "host_taken"],
      [{ ok: false, reason: "precondition", detail: "state_busy" }, "state_busy"],
      [{ ok: false, reason: "precondition", detail: "no_env" }, "no_env"],
      [{ ok: false, reason: "precondition", detail: "env_missing", step: 1 }, "precondition"],
      [{ ok: false, reason: "precondition", detail: "host_not_in_route", step: 3 }, "precondition"],
      [{ ok: false, reason: "retry", issue: "not_failed" }, "precondition"],
      [{ ok: false, reason: "quota", violation: "db_provision_day" }, "quota"],
      [{ ok: false, reason: "duplicate", existingJobId: "" }, "duplicate"],
      [{ ok: false, reason: "invalid", issue: "platform_forbidden", step: 0 }, "invalid"],
      [{ ok: false, reason: "one_admin", conflict: "user" }, "one_admin"],
      [{ ok: false, reason: "tenant_inactive" }, "tenant_inactive"],
      [{ ok: false, reason: "disabled" }, "disabled"],
      [{ ok: false, reason: "error", message: "pg" }, "error"],
    ];
    for (const [o, code] of cases) {
      expect(tenantOutcomeCode(o)).toBe(code);
      expect((ACTION_RESULT_CODES as readonly string[]).includes(code)).toBe(true);
      expect(ACTION_RESULT_TEXT[code as keyof typeof ACTION_RESULT_TEXT]).toBeTruthy();
    }
  });

  it("kuota rantai: odoo_db_provision 3/hari ikut dihitung (rantai onboarding)", () => {
    const zero: ChainQuotaCounts = {
      totalLastHour: 0,
      kcUserLastHour: 0,
      kcUserDisableLastHour: 0,
      kcActionEmailLastHour: 0,
      kcRealmSyncLastDay: 0,
      tenantStateLastDay: 0,
      odooUserLastHour: 0,
      actorChainsLastMinute: 0,
    };
    const db = { type: "odoo_db_provision" as const, dryRun: false, args: {} };
    expect(evaluateChainQuota(zero, [db, db, db])).toBeNull();
    expect(evaluateChainQuota(zero, [db, db, db, db])).toBe("db_provision_day");
    expect(evaluateChainQuota({ ...zero, dbProvisionLastDay: 2 }, [db])).toBeNull();
    expect(evaluateChainQuota({ ...zero, dbProvisionLastDay: 2 }, [db, db])).toBe("db_provision_day");
    // Onboarding prod+demo (14 langkah) muat di kuota total 60/jam.
    expect(evaluateChainQuota({ ...zero, totalLastHour: 46 }, Array.from({ length: 14 }, () => ({ type: "kc_org_ensure" as const, dryRun: false, args: {} })))).toBeNull();
    expect(P1_QUOTA.tenantStatePerDay).toBe(20);
  });

  it("izin: hanya superadmin memutasi tenant/realm; ops boleh baca audit/tenant; role klien tidak", () => {
    expect(PERMISSIONS["clients:manage"]).toEqual(["superadmin"]);
    expect(PERMISSIONS["realm:sync"]).toEqual(["superadmin"]);
    expect(PERMISSIONS["audit:view"]).toEqual(["superadmin", "ops"]);
    expect(can(["ops"], "jobs:view")).toBe(true);
    for (const r of ["client_admin", "client_user"] as const) {
      expect(can([r], "audit:view")).toBe(false);
      expect(can([r], "jobs:view")).toBe(false);
      expect(can([r], "realm:sync")).toBe(false);
    }
    expect(can(["ops"], "realm:sync")).toBe(false);
    expect(can(["ops"], "clients:manage")).toBe(false);
  });

  it("tipe yang dibutuhkan fitur ada di kontrak", () => {
    for (const t of ONBOARDING_TYPES) expect([...LEGACY_JOB_TYPES, ...SAAS_P1_JOB_TYPES]).toContain(t);
  });
});
