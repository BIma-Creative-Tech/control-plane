/**
 * Migrasi prod M8 — "Daftarkan tenant yang sudah ada": parsing/validasi form (konvensi db_name, slug platform, host
 * kustom DIIZINKAN di sini tetapi DITOLAK di onboarding, host zona platform), komposisi rantai (hanya kc_org_ensure +
 * odoo_tenant_config, tunduk allowlist), turunan route manual dari regex HOST, ketersediaan tombol job, kode umpan balik.
 */
import { describe, expect, it } from "vitest";
import { validateChain } from "@/jobs/chain";
import { enqueueOutcomeCode } from "@/jobs/service";
import { registerOutcomeCode, tenantOutcomeCode, type RegisterOutcome } from "@/jobs/tenants";
import {
  BRIDGE_JOB_TYPES,
  LEGACY_JOB_TYPES,
  MANUAL_ROUTE_BLOCKED_TYPES,
  envRouteHost,
  instanceJobTypes,
  routeManagedManually,
} from "@/lib/job-contract";
import { ACTION_RESULT_CODES, ACTION_RESULT_TEXT } from "@/lib/job-list-params";
import { parseOnboardingForm, retryableOrigin } from "@/lib/tenant-onboarding";
import {
  MANUAL_ROUTE_NOTE,
  REGISTER_EXISTING_TYPES,
  buildRegisterExistingSteps,
  environmentJobAvailability,
  parseRegisterExistingForm,
  registerAuditMetadata,
  registeredEnvironmentRowValues,
  validateRegisterInput,
  type RegisterExistingInput,
} from "@/lib/tenant-register";

const TID = "22222222-2222-4222-8222-222222222222";
const entries = (o: Record<string, string>) => Object.entries(o) as [string, string][];
const expo = {
  slug: "expomedia",
  name: "PT Expomedia",
  brand: "Expomedia",
  prod: "on",
  prod_db_name: "expomedia_prod",
  prod_host: "erp.expomedia.id",
  prod_db_status: "provisioned",
  prod_route_status: "active",
  prod_sso_status: "active",
  demo_db_name: "",
  demo_host: "",
  demo_db_status: "provisioned",
  demo_route_status: "active",
  demo_sso_status: "active",
};

describe("form pendaftaran: parsing & validasi", () => {
  it("expomedia prod dengan host KUSTOM + DB konvensi → diterima, status deklarasi persis", () => {
    const r = parseRegisterExistingForm("prod", entries(expo));
    expect(r).toEqual({
      success: true,
      data: {
        slug: "expomedia",
        name: "PT Expomedia",
        brand: "Expomedia",
        planId: null,
        envs: [{ kind: "prod", host: "erp.expomedia.id", dbName: "expomedia_prod", dbStatus: "provisioned", routeStatus: "active", ssoStatus: "active" }],
      },
    });
  });

  it("host kustom DIIZINKAN di pendaftaran tetapi DITOLAK di onboarding (aturan HOST platform)", () => {
    expect(parseRegisterExistingForm("prod", entries(expo)).success).toBe(true);
    const onboarding = parseOnboardingForm(
      "prod",
      entries({ slug: "expomedia", name: "PT Expomedia", admin_email: "a@expomedia.id", admin_name: "Admin", prod_host: "erp.expomedia.id" }),
    );
    expect(onboarding).toEqual({ success: false, issue: "host_invalid" });
  });

  it("db_name wajib = konvensi <slug '-'→'_'>_<env>", () => {
    for (const bad of ["expomedia", "expomedia_production", "expo_prod", "expomedia_demo", "EXPOMEDIA_PROD"]) {
      const r = parseRegisterExistingForm("prod", entries({ ...expo, prod_db_name: bad }));
      expect(r.success ? "ok" : r.issue, bad).toBe("db_name_mismatch");
    }
    // slug bertanda hubung → garis bawah
    expect(parseRegisterExistingForm("prod", entries({ ...expo, slug: "acme-co", prod_db_name: "acme-co_prod" }))).toEqual({ success: false, issue: "db_name_mismatch" });
    expect(parseRegisterExistingForm("prod", entries({ ...expo, slug: "acme-co", prod_db_name: "acme_co_prod" })).success).toBe(true);
  });

  it("slug platform dicadangkan; slug tidak valid ditolak", () => {
    expect(parseRegisterExistingForm("prod", entries({ ...expo, slug: "platform", prod_db_name: "platform_prod" }))).toEqual({ success: false, issue: "slug_reserved" });
    for (const s of ["ab", "-expo", "expo-", "Expo", "expo_media"]) {
      expect(parseRegisterExistingForm("prod", entries({ ...expo, slug: s })).success, s).toBe(false);
    }
  });

  it("host di zona platform wajib host platform yang sah untuk env-nya; host bukan FQDN ditolak", () => {
    for (const h of ["erp.bimacreative.tech", "a.b.erp.bimacreative.tech", "expomedia.staging.bimacreative.tech", "bimacreative.tech", "erp_expomedia.id", "localhost"]) {
      const r = parseRegisterExistingForm("prod", entries({ ...expo, prod_host: h }));
      expect(r.success ? "ok" : r.issue, h).toBe("host_invalid");
    }
    // Zona platform dari env PLATFORM_DOMAINS (bukan hanya default).
    expect(parseRegisterExistingForm("prod", entries(expo), ["expomedia.id"])).toEqual({ success: false, issue: "host_invalid" });
    // Host platform sah → diterima (bukan route manual).
    const ok = parseRegisterExistingForm("prod", entries({ ...expo, prod_host: "expomedia.erp.bimacreative.tech" }));
    expect(ok.success).toBe(true);
  });

  it("env: tidak dicentang tetapi terisi → invalid; tanpa env → no_env; host sama antar-env → host_invalid; demo berhasil", () => {
    expect(parseRegisterExistingForm("prod", entries({ ...expo, demo_db_name: "expomedia_demo" })).success).toBe(false);
    const noEnv = { ...expo } as Record<string, string>;
    delete noEnv.prod;
    noEnv.prod_db_name = "";
    noEnv.prod_host = "";
    expect(parseRegisterExistingForm("prod", entries(noEnv))).toEqual({ success: false, issue: "no_env" });
    const both = { ...expo, demo: "on", demo_db_name: "expomedia_demo", demo_host: "erp.expomedia.id", demo_sso_status: "none" };
    expect(parseRegisterExistingForm("prod", entries(both))).toEqual({ success: false, issue: "host_invalid" });
    const r = parseRegisterExistingForm("prod", entries({ ...both, demo_host: "demo.expomedia.id" }));
    expect(r.success && r.data.envs.map((e) => [e.kind, e.dbName, e.ssoStatus])).toEqual([
      ["prod", "expomedia_prod", "active"],
      ["demo", "expomedia_demo", "none"],
    ]);
  });

  it("status deklarasi hanya db=provisioned, route=active, sso=active|none; field asing/env instance lain ditolak", () => {
    const patches: Record<string, string>[] = [{ prod_db_status: "absent" }, { prod_route_status: "removed" }, { prod_sso_status: "disabled" }, { extra: "x" }, { prod_host: "" }];
    for (const patch of patches) {
      expect(parseRegisterExistingForm("prod", entries({ ...expo, ...patch })).success, JSON.stringify(patch)).toBe(false);
    }
    // staging-inst: field prod/demo tidak dikenal (strict) → invalid; staging sendiri diterima.
    expect(parseRegisterExistingForm("staging", entries(expo)).success).toBe(false);
    const st = parseRegisterExistingForm(
      "staging",
      entries({ slug: "expomedia", name: "PT Expomedia", staging: "on", staging_db_name: "expomedia_staging", staging_host: "erp-staging.expomedia.id", staging_db_status: "provisioned", staging_route_status: "active", staging_sso_status: "none" }),
    );
    expect(st.success && st.data.envs).toEqual([{ kind: "staging", host: "erp-staging.expomedia.id", dbName: "expomedia_staging", dbStatus: "provisioned", routeStatus: "active", ssoStatus: "none" }]);
    // plan_id opsional harus UUID.
    expect(parseRegisterExistingForm("prod", entries({ ...expo, plan_id: "x" })).success).toBe(false);
    const p = parseRegisterExistingForm("prod", entries({ ...expo, plan_id: TID }));
    expect(p.success && p.data.planId).toBe(TID);
  });

  it("validasi layanan (pertahanan berlapis) = aturan form, termasuk env di luar instance", () => {
    const f: RegisterExistingInput = {
      slug: "expomedia",
      name: "PT Expomedia",
      brand: null,
      planId: null,
      envs: [{ kind: "prod", host: "erp.expomedia.id", dbName: "expomedia_prod", dbStatus: "provisioned", routeStatus: "active", ssoStatus: "active" }],
    };
    expect(validateRegisterInput("prod", f)).toBeNull();
    expect(validateRegisterInput("staging", f)).toBe("no_env");
    expect(validateRegisterInput("prod", { ...f, slug: "platform" })).toBe("slug_reserved");
    expect(validateRegisterInput("prod", { ...f, envs: [{ ...f.envs[0]!, dbName: "other_prod" }] })).toBe("db_name_mismatch");
    expect(validateRegisterInput("prod", { ...f, envs: [] })).toBe("no_env");
    expect(validateRegisterInput("prod", { ...f, envs: [f.envs[0]!, f.envs[0]!] })).toBe("invalid");
  });
});

describe("rantai pendaftaran", () => {
  const ALL = [...BRIDGE_JOB_TYPES];
  it("kc_org_ensure (tenant_id) lalu odoo_tenant_config(compat) per env ber-SSO aktif — tanpa langkah route/SSO/DB", () => {
    const r = buildRegisterExistingSteps({
      tenantId: TID,
      realmEnv: "prod",
      envs: [
        { kind: "prod", ssoStatus: "active" },
        { kind: "demo", ssoStatus: "none" },
      ],
      allowedTypes: ALL,
    });
    expect(r).toEqual({
      steps: [
        { type: "kc_org_ensure", env: "prod", args: { tenant_id: TID } },
        { type: "odoo_tenant_config", env: "prod", args: { tenant_check: "compat" } },
      ],
      skipped: [],
    });
    expect(r.steps.some((s) => (LEGACY_JOB_TYPES as readonly string[]).includes(s.type))).toBe(false);
    // Lolos kontrak rantai untuk slug tenant (host kustom tidak muncul di args mana pun).
    expect(validateChain("prod", ALL, "expomedia", r.steps).ok).toBe(true);
  });

  it("allowlist: tipe tidak diizinkan dilewati; allowlist lama (5 tipe) → tanpa langkah (baris data saja)", () => {
    const envs = [{ kind: "prod" as const, ssoStatus: "active" as const }];
    expect(buildRegisterExistingSteps({ tenantId: TID, realmEnv: "prod", envs, allowedTypes: instanceJobTypes(undefined) })).toEqual({
      steps: [],
      skipped: ["kc_org_ensure", "odoo_tenant_config"],
    });
    const partial = buildRegisterExistingSteps({ tenantId: TID, realmEnv: "prod", envs, allowedTypes: instanceJobTypes("odoo_route,kc_org_ensure") });
    expect(partial.steps.map((s) => s.type)).toEqual(["kc_org_ensure"]);
    expect(partial.skipped).toEqual(["odoo_tenant_config"]);
    expect(REGISTER_EXISTING_TYPES).toEqual(["kc_org_ensure", "odoo_tenant_config"]);
  });

  it("staging-inst: identitas di realm staging", () => {
    const r = buildRegisterExistingSteps({ tenantId: TID, realmEnv: "staging", envs: [{ kind: "staging", ssoStatus: "active" }], allowedTypes: ALL });
    expect(r.steps.map((s) => `${s.type}@${s.env}`)).toEqual(["kc_org_ensure@staging", "odoo_tenant_config@staging"]);
    expect(validateChain("staging", ALL, "expomedia", r.steps).ok).toBe(true);
  });

  it("rantai pendaftaran boleh diulang dari halaman tenant (origin)", () => {
    expect(retryableOrigin("tenant.register_existing")).toBe(true);
  });
});

describe("route manual (turunan regex HOST, tanpa kolom)", () => {
  it("host kustom → manual; host platform env-nya → bukan; fallback hostname url; host tak terbaca → manual (fail-closed)", () => {
    expect(routeManagedManually({ kind: "prod", host: "erp.expomedia.id", url: "https://erp.expomedia.id" })).toBe(true);
    expect(routeManagedManually({ kind: "prod", host: "acme.erp.bimacreative.tech", url: "https://acme.erp.bimacreative.tech" })).toBe(false);
    expect(routeManagedManually({ kind: "demo", host: "acme-demo.erp.bimacreative.tech", url: "https://x" })).toBe(false);
    expect(routeManagedManually({ kind: "staging", host: "acme.erp.bimacreative.tech", url: "https://x" })).toBe(true);
    expect(routeManagedManually({ kind: "prod", host: null, url: "https://acme.erp.bimacreative.tech" })).toBe(false);
    expect(routeManagedManually({ kind: "prod", host: null, url: "https://erp.expomedia.id/web" })).toBe(true);
    expect(routeManagedManually({ kind: "prod", host: null, url: "bukan url" })).toBe(true);
    expect(envRouteHost({ host: null, url: "https://acme.erp.bimacreative.tech" })).toBe("acme.erp.bimacreative.tech");
  });

  it("tombol job: route manual → DB/route/SSO nonaktif + catatan; host platform → aktif", () => {
    expect(environmentJobAvailability({ kind: "prod", host: "erp.expomedia.id", url: "https://erp.expomedia.id" })).toEqual({
      manualRoute: true,
      dbProvision: false,
      route: false,
      sso: false,
      note: MANUAL_ROUTE_NOTE,
    });
    expect(environmentJobAvailability({ kind: "prod", host: null, url: "https://acme.erp.bimacreative.tech" })).toEqual({
      manualRoute: false,
      dbProvision: true,
      route: true,
      sso: true,
      note: null,
    });
    expect(MANUAL_ROUTE_NOTE).toBe("Route manual — diadopsi di Fase 2");
    expect([...MANUAL_ROUTE_BLOCKED_TYPES].sort()).toEqual(["odoo_db_provision", "odoo_route", "odoo_sso_disable", "odoo_sso_provision"]);
  });

  it("nilai baris environment + metadata audit (tanpa PII, tanda route_manual)", () => {
    const e = { kind: "prod" as const, host: "erp.expomedia.id", dbName: "expomedia_prod", dbStatus: "provisioned" as const, routeStatus: "active" as const, ssoStatus: "active" as const };
    expect(registeredEnvironmentRowValues(e)).toEqual({
      kind: "prod",
      odooInstance: "pool-a",
      dbName: "expomedia_prod",
      url: "https://erp.expomedia.id",
      host: "erp.expomedia.id",
      dbStatus: "provisioned",
      routeStatus: "active",
      ssoStatus: "active",
    });
    const md = registerAuditMetadata({ slug: "expomedia", name: "PT Expomedia", brand: "Expomedia", planId: null, envs: [e] });
    expect(md).toEqual({
      slug: "expomedia",
      brand: "Expomedia",
      envs: ["prod"],
      environments: [{ kind: "prod", db_name: "expomedia_prod", host: "erp.expomedia.id", db: "provisioned", route: "active", sso: "active", route_manual: true }],
    });
    expect(JSON.stringify(md)).not.toContain("@");
  });
});

describe("kode umpan balik", () => {
  it("setiap hasil pendaftaran → kode di ACTION_RESULT_CODES + punya teks", () => {
    const cases: [RegisterOutcome, string][] = [
      [{ ok: true, clientId: TID, chainId: TID, jobIds: [TID], skipped: [] }, "queued"],
      [{ ok: true, clientId: TID, chainId: TID, jobIds: [TID], skipped: ["odoo_tenant_config"] }, "registered_partial"],
      [{ ok: true, clientId: TID, chainId: null, jobIds: [], skipped: ["kc_org_ensure"] }, "registered_no_jobs"],
      [{ ok: false, reason: "exists" }, "exists"],
      [{ ok: false, reason: "forbidden" }, "forbidden"],
      [{ ok: false, reason: "register", issue: "db_name_mismatch" }, "db_name_mismatch"],
      [{ ok: false, reason: "register", issue: "slug_reserved" }, "slug_reserved"],
      [{ ok: false, reason: "register", issue: "host_invalid" }, "host_invalid"],
      [{ ok: false, reason: "precondition", detail: "host_taken" }, "host_taken"],
      [{ ok: false, reason: "precondition", detail: "plan_inactive" }, "plan_inactive"],
      [{ ok: false, reason: "precondition", detail: "no_env" }, "no_env"],
    ];
    for (const [o, code] of cases) {
      expect(registerOutcomeCode(o)).toBe(code);
      expect((ACTION_RESULT_CODES as readonly string[]).includes(code)).toBe(true);
      expect(ACTION_RESULT_TEXT[code as keyof typeof ACTION_RESULT_TEXT]).toBeTruthy();
    }
  });

  it("route_manual dari rantai dan halaman environment → kode route_manual", () => {
    expect(tenantOutcomeCode({ ok: false, reason: "precondition", detail: "route_manual", step: 0 })).toBe("route_manual");
    expect(enqueueOutcomeCode({ ok: false, reason: "precondition", detail: "route_manual" })).toBe("route_manual");
    expect(enqueueOutcomeCode({ ok: false, reason: "precondition", detail: "route_not_active" })).toBe("precondition");
    expect(enqueueOutcomeCode({ ok: true, jobId: TID })).toBe("queued");
  });
});
