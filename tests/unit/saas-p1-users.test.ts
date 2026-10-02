/**
 * SaaS Fase 1 — Users (kontrak docs/plans/saas-phase-1-contract.md §2, repo infra): izin, otorisasi lintas tenant,
 * aturan satu admin, rencana rantai job, idempotency, kuota rantai, rekonsiliasi dari RESULT, form.
 */
import { describe, expect, it } from "vitest";
import { canonicalJson, chainAdminEmails, chainHasAdopt, validateChain } from "@/jobs/chain";
import { planUserReconcile, type UserReconcileJob } from "@/jobs/user-reconcile";
import { USER_FEATURE_TYPES, userFeatureEnabled, userOutcomeCode } from "@/jobs/users";
import { decideAccess } from "@/lib/access";
import { webEnvSchema } from "@/env";
import {
  BRIDGE_JOB_TYPES,
  LEGACY_JOB_TYPES,
  NAME_REGEX,
  RESULT_KEYS,
  SAAS_P1_JOB_TYPES,
  asciiName,
  buildJobFile,
  idempotencyKey,
  instanceJobTypes,
  realmEnvForInstance,
  sanitizeResult,
  validateJobRequest,
} from "@/lib/job-contract";
import { parseForm } from "@/lib/job-forms";
import { ACTION_RESULT_CODES, ACTION_RESULT_TEXT } from "@/lib/job-list-params";
import { P1_QUOTA, evaluateChainQuota, type ChainQuotaCounts } from "@/lib/quota";
import { PERMISSIONS, ROLE_LABELS, can, canWith, type PermissionMap, type Role } from "@/lib/roles";
import {
  authorizeAdopt,
  authorizeUserMutation,
  buildAccessSteps,
  buildAddUserSteps,
  buildAdoptSteps,
  buildDisableSteps,
  buildEnableSteps,
  buildPasswordResetSteps,
  emailBindingConflict,
  orderChain,
  type ChainStep,
  type TargetUser,
  type TenantRef,
  type UserActorContext,
} from "@/lib/user-admin";
import { parseUserForm } from "@/lib/user-forms";

const ACME: TenantRef = { id: "11111111-1111-4111-8111-111111111111", slug: "acme-co", isPlatform: false, terminated: false };
const BETA: TenantRef = { id: "22222222-2222-4222-8222-222222222222", slug: "beta-co", isPlatform: false, terminated: false };
const PLATFORM: TenantRef = { id: "33333333-3333-4333-8333-333333333333", slug: "platform", isPlatform: true, terminated: false };
const ENV_PROD = "44444444-4444-4444-8444-444444444444";
const ENV_DEMO = "55555555-5555-4555-8555-555555555555";
const ENV_STG = "66666666-6666-4666-8666-666666666666";

const actor = (roles: Role[], clientId: string | null, sub = "actor-sub", status: UserActorContext["status"] = "active"): UserActorContext => ({
  sub,
  roles,
  userId: "77777777-7777-4777-8777-777777777777",
  clientId,
  status,
});
const target = (over: Partial<TargetUser> = {}): TargetUser => ({
  id: "88888888-8888-4888-8888-888888888888",
  keycloakSub: "target-sub",
  email: "budi@acme.co.id",
  role: "client_user",
  status: "active",
  clientId: ACME.id,
  ...over,
});
const NO_ADMIN = { otherActiveAdmins: 0 };
const ONE_ADMIN = { otherActiveAdmins: 1 };
/**
 * Portal tenant (W6, AKTIF): `users:manage_own` = client_admin di PERMISSIONS produksi, HANYA lewat kanal `portal`
 * (kanal platform /users → forbidden, temuan QA F1.3 tetap). `W6` = peta produksi (alias, dipertahankan untuk uji).
 */
const W6: PermissionMap = PERMISSIONS;
const NO_ADMIN_W6 = { otherActiveAdmins: 0, permissions: W6, channel: "portal" as const };
const ONE_ADMIN_W6 = { otherActiveAdmins: 1, permissions: W6, channel: "portal" as const };

describe("izin Users (roles.ts, default deny)", () => {
  it("users:view = superadmin+ops; users:manage = superadmin; users:manage_own = client_admin (W6 portal saja); realm:sync = superadmin", () => {
    expect(can(["superadmin"], "users:view")).toBe(true);
    expect(can(["ops"], "users:view")).toBe(true);
    expect(can(["client_admin"], "users:view")).toBe(false);
    expect(can(["client_user"], "users:view")).toBe(false);
    expect(can(["ops"], "users:manage")).toBe(false);
    expect(can(["client_admin"], "users:manage")).toBe(false);
    expect(can(["client_admin"], "users:manage_own")).toBe(true);
    expect(PERMISSIONS["users:manage_own"]).toEqual(["client_admin"]);
    expect(canWith(W6, ["client_admin"], "users:manage_own")).toBe(true);
    expect(can(["client_user"], "users:manage_own")).toBe(false);
    expect(can(["ops"], "realm:sync")).toBe(false);
    expect(can(["superadmin"], "realm:sync")).toBe(true);
  });
  it("tanpa role / role kosong → ditolak semua izin Users", () => {
    for (const p of ["users:view", "users:manage", "users:manage_own", "realm:sync"] as const) {
      expect(can([], p)).toBe(false);
      expect(can(undefined, p)).toBe(false);
      expect(decideAccess({ roles: [] }, p)).toBe("forbidden");
      expect(decideAccess(null, p)).toBe("login");
    }
  });
  it("label UI role (K9)", () => {
    expect(ROLE_LABELS).toEqual({
      superadmin: "platform-admin",
      ops: "platform-viewer",
      client_admin: "tenant-admin",
      client_user: "tenant-user",
    });
  });
});

describe("authorizeUserMutation — cakupan & lintas tenant", () => {
  it("F1.3 + W6: client_admin lewat kanal platform (/users) → forbidden untuk setiap mutasi; lewat portal → scope own", () => {
    const ca = actor(["client_admin"], ACME.id);
    const muts = [
      { kind: "add", cpRole: "client_user" },
      { kind: "change_access", target: target(), cpRole: "client_user" },
      { kind: "disable", target: target() },
      { kind: "enable", target: target({ status: "disabled" }), cpRole: "client_user" },
      { kind: "password_reset", target: target() },
    ] as const;
    for (const m of muts) {
      expect(authorizeUserMutation(ca, ACME, m, NO_ADMIN)).toEqual({ ok: false, reason: "forbidden" });
      expect(authorizeUserMutation(ca, ACME, m, { ...NO_ADMIN, channel: "platform" })).toEqual({ ok: false, reason: "forbidden" });
      expect(authorizeUserMutation(ca, ACME, m, NO_ADMIN_W6)).toEqual({ ok: true, scope: "own" });
    }
  });
  it("ops / client_user / tanpa role → forbidden untuk setiap mutasi", () => {
    for (const roles of [["ops"], ["client_user"], []] as Role[][]) {
      expect(authorizeUserMutation(actor(roles, ACME.id), ACME, { kind: "add", cpRole: "client_user" }, NO_ADMIN)).toEqual({ ok: false, reason: "forbidden" });
      expect(authorizeUserMutation(actor(roles, ACME.id), ACME, { kind: "disable", target: target() }, NO_ADMIN)).toEqual({ ok: false, reason: "forbidden" });
      expect(authorizeUserMutation(actor(roles, ACME.id), ACME, { kind: "password_reset", target: target() }, NO_ADMIN)).toEqual({ ok: false, reason: "forbidden" });
    }
  });
  it("client_admin: tenant sendiri boleh (scope own)", () => {
    expect(authorizeUserMutation(actor(["client_admin"], ACME.id), ACME, { kind: "add", cpRole: "client_user" }, ONE_ADMIN_W6)).toEqual({ ok: true, scope: "own" });
    expect(authorizeUserMutation(actor(["client_admin"], ACME.id), ACME, { kind: "disable", target: target() }, ONE_ADMIN_W6)).toEqual({ ok: true, scope: "own" });
    expect(authorizeUserMutation(actor(["client_admin"], ACME.id), ACME, { kind: "password_reset", target: target() }, ONE_ADMIN_W6)).toEqual({ ok: true, scope: "own" });
  });
  it("client_admin: tenant lain / tanpa tenant / platform → cross_tenant", () => {
    expect(authorizeUserMutation(actor(["client_admin"], ACME.id), BETA, { kind: "add", cpRole: "client_user" }, NO_ADMIN_W6)).toEqual({ ok: false, reason: "cross_tenant" });
    expect(authorizeUserMutation(actor(["client_admin"], null), ACME, { kind: "add", cpRole: "client_user" }, NO_ADMIN_W6)).toEqual({ ok: false, reason: "cross_tenant" });
    expect(authorizeUserMutation(actor(["client_admin"], PLATFORM.id), PLATFORM, { kind: "add", cpRole: "client_user" }, NO_ADMIN_W6)).toEqual({ ok: false, reason: "cross_tenant" });
    // target milik tenant lain walau tenant yang dikirim = tenant sendiri
    expect(
      authorizeUserMutation(actor(["client_admin"], ACME.id), ACME, { kind: "disable", target: target({ clientId: BETA.id }) }, NO_ADMIN_W6),
    ).toEqual({ ok: false, reason: "cross_tenant" });
    expect(
      authorizeUserMutation(actor(["client_admin"], ACME.id), BETA, { kind: "password_reset", target: target({ clientId: BETA.id }) }, NO_ADMIN_W6),
    ).toEqual({ ok: false, reason: "cross_tenant" });
  });
  it("superadmin: target harus anggota tenant yang dikirim", () => {
    expect(
      authorizeUserMutation(actor(["superadmin"], PLATFORM.id), ACME, { kind: "disable", target: target({ clientId: BETA.id }) }, NO_ADMIN),
    ).toEqual({ ok: false, reason: "cross_tenant" });
  });
  it("client_admin tidak bisa memberi superadmin/ops/none (tidak pernah memberi hak lebih)", () => {
    for (const r of ["superadmin", "ops", "none"] as const) {
      expect(authorizeUserMutation(actor(["client_admin"], ACME.id), ACME, { kind: "add", cpRole: r }, NO_ADMIN_W6)).toEqual({ ok: false, reason: "role_not_allowed" });
      expect(
        authorizeUserMutation(actor(["client_admin"], ACME.id), ACME, { kind: "change_access", target: target(), cpRole: r }, NO_ADMIN_W6),
      ).toEqual({ ok: false, reason: "role_not_allowed" });
    }
  });
  it("client_admin tidak menyentuh user ber-role platform walau tercatat di tenantnya", () => {
    expect(
      authorizeUserMutation(actor(["client_admin"], ACME.id), ACME, { kind: "disable", target: target({ role: "superadmin" }) }, NO_ADMIN_W6),
    ).toEqual({ ok: false, reason: "role_not_allowed" });
  });
  it("superadmin: §0.3 role platform hanya di platform, role tenant hanya di tenant", () => {
    const sa = actor(["superadmin"], PLATFORM.id);
    expect(authorizeUserMutation(sa, ACME, { kind: "add", cpRole: "superadmin" }, NO_ADMIN)).toEqual({ ok: false, reason: "role_not_allowed" });
    expect(authorizeUserMutation(sa, ACME, { kind: "add", cpRole: "ops" }, NO_ADMIN)).toEqual({ ok: false, reason: "role_not_allowed" });
    expect(authorizeUserMutation(sa, PLATFORM, { kind: "add", cpRole: "client_user" }, NO_ADMIN)).toEqual({ ok: false, reason: "role_not_allowed" });
    expect(authorizeUserMutation(sa, PLATFORM, { kind: "add", cpRole: "client_admin" }, NO_ADMIN)).toEqual({ ok: false, reason: "role_not_allowed" });
    expect(authorizeUserMutation(sa, PLATFORM, { kind: "add", cpRole: "ops" }, NO_ADMIN)).toEqual({ ok: true, scope: "all" });
    expect(authorizeUserMutation(sa, ACME, { kind: "add", cpRole: "none" }, NO_ADMIN)).toEqual({ ok: true, scope: "all" });
  });
  it("diri sendiri: tidak bisa menonaktifkan / mengubah role sendiri; ubah akses Odoo dengan role sama boleh", () => {
    const sa = actor(["superadmin"], PLATFORM.id, "me");
    const me = target({ keycloakSub: "me", role: "superadmin", clientId: PLATFORM.id });
    expect(authorizeUserMutation(sa, PLATFORM, { kind: "disable", target: me }, NO_ADMIN)).toEqual({ ok: false, reason: "self_action" });
    expect(authorizeUserMutation(sa, PLATFORM, { kind: "change_access", target: me, cpRole: "ops" }, NO_ADMIN)).toEqual({ ok: false, reason: "self_action" });
    expect(authorizeUserMutation(sa, PLATFORM, { kind: "change_access", target: me, cpRole: "superadmin" }, NO_ADMIN)).toEqual({ ok: true, scope: "all" });
    const ca = actor(["client_admin"], ACME.id, "ca");
    const caSelf = target({ keycloakSub: "ca", role: "client_admin" });
    expect(authorizeUserMutation(ca, ACME, { kind: "disable", target: caSelf }, NO_ADMIN_W6)).toEqual({ ok: false, reason: "self_action" });
    expect(authorizeUserMutation(ca, ACME, { kind: "change_access", target: caSelf, cpRole: "client_user" }, NO_ADMIN_W6)).toEqual({ ok: false, reason: "self_action" });
  });
  it("superadmin boleh menonaktifkan superadmin LAIN di platform", () => {
    const other = target({ keycloakSub: "other", role: "superadmin", clientId: PLATFORM.id });
    expect(authorizeUserMutation(actor(["superadmin"], PLATFORM.id, "me"), PLATFORM, { kind: "disable", target: other }, NO_ADMIN)).toEqual({ ok: true, scope: "all" });
  });
  it("aktor berstatus disabled (sesi JWT masih hidup) → ditolak", () => {
    expect(authorizeUserMutation(actor(["superadmin"], PLATFORM.id, "x", "disabled"), ACME, { kind: "add", cpRole: "client_user" }, NO_ADMIN)).toEqual({
      ok: false,
      reason: "actor_disabled",
    });
  });
  it("tenant terminated: hanya nonaktifkan yang boleh; user disabled: ubah akses/reset ditolak", () => {
    const term = { ...ACME, terminated: true };
    const sa = actor(["superadmin"], PLATFORM.id);
    expect(authorizeUserMutation(sa, term, { kind: "add", cpRole: "client_user" }, NO_ADMIN)).toEqual({ ok: false, reason: "tenant_inactive" });
    expect(authorizeUserMutation(sa, term, { kind: "disable", target: target() }, NO_ADMIN)).toEqual({ ok: true, scope: "all" });
    const dis = target({ status: "disabled" });
    expect(authorizeUserMutation(sa, ACME, { kind: "password_reset", target: dis }, NO_ADMIN)).toEqual({ ok: false, reason: "target_disabled" });
    expect(authorizeUserMutation(sa, ACME, { kind: "change_access", target: dis, cpRole: "client_user" }, NO_ADMIN)).toEqual({ ok: false, reason: "target_disabled" });
  });
});

describe("aturan satu tenant-admin (ADR 0018 D3)", () => {
  const sa = actor(["superadmin"], PLATFORM.id);
  it("tambah client_admin saat admin lain ada → one_admin; tanpa admin → ok", () => {
    expect(authorizeUserMutation(sa, ACME, { kind: "add", cpRole: "client_admin" }, ONE_ADMIN)).toEqual({ ok: false, reason: "one_admin" });
    expect(authorizeUserMutation(sa, ACME, { kind: "add", cpRole: "client_admin" }, NO_ADMIN)).toEqual({ ok: true, scope: "all" });
  });
  it("promosi user → client_admin saat admin lain ada → one_admin", () => {
    expect(authorizeUserMutation(sa, ACME, { kind: "change_access", target: target(), cpRole: "client_admin" }, ONE_ADMIN)).toEqual({
      ok: false,
      reason: "one_admin",
    });
  });
  it("admin yang sama mengubah akses Odoo (role tetap) → ok", () => {
    expect(
      authorizeUserMutation(sa, ACME, { kind: "change_access", target: target({ role: "client_admin" }), cpRole: "client_admin" }, NO_ADMIN),
    ).toEqual({ ok: true, scope: "all" });
  });
  it("aktifkan admin nonaktif saat admin lain sudah ada → one_admin", () => {
    expect(
      authorizeUserMutation(sa, ACME, { kind: "enable", target: target({ role: "client_admin", status: "disabled" }), cpRole: "client_admin" }, ONE_ADMIN),
    ).toEqual({ ok: false, reason: "one_admin" });
  });
  it("client_admin tidak bisa menambah client_admin kedua (dirinya = admin yang ada)", () => {
    // Keputusan Lead Fase 1: memberi client_admin = superadmin saja → dari portal role_not_allowed (sebelum aturan satu admin).
    expect(authorizeUserMutation(actor(["client_admin"], ACME.id), ACME, { kind: "add", cpRole: "client_admin" }, ONE_ADMIN_W6)).toEqual({
      ok: false,
      reason: "role_not_allowed",
    });
    expect(authorizeUserMutation(actor(["client_admin"], ACME.id), ACME, { kind: "add", cpRole: "client_admin" }, NO_ADMIN_W6)).toEqual({
      ok: false,
      reason: "role_not_allowed",
    });
  });
});

/** Setiap langkah rencana harus lolos kontrak dispatcher (validateJobRequest + file job). */
function assertContract(slug: string, steps: ChainStep[], instance: "prod" | "staging" = "prod") {
  for (const [i, s] of steps.entries()) {
    const v = validateJobRequest(instance, { type: s.type, slug, env: s.env, dryRun: false, args: s.args });
    expect(v.ok, `${i} ${s.type}@${s.env}`).toBe(true);
    buildJobFile(instance, {
      id: "3f2c7a9e-1b4d-4e8a-9c3f-5a6b7c8d9e0f",
      type: s.type,
      slug,
      env: s.env,
      dryRun: false,
      actor: "user:6b1f0e2a-4c3d-4e5f-8a9b-0c1d2e3f4a5b",
      createdAt: new Date("2026-10-02T10:00:00Z"),
      args: s.args,
    });
  }
  expect(validateChain(instance, BRIDGE_JOB_TYPES, slug, steps).ok).toBe(true);
}

describe("rencana rantai job", () => {
  const envs = [
    { environmentId: ENV_PROD, kind: "prod" as const },
    { environmentId: ENV_DEMO, kind: "demo" as const },
  ];
  const base = { realmEnv: realmEnvForInstance("prod"), email: "budi@acme.co.id", envs };

  it("tambah user tenant: [org] → kc_user_ensure → kc_user_set_roles per env berakses → odoo_user_ensure per env", () => {
    const steps = buildAddUserSteps({
      ...base,
      tenant: ACME,
      name: "Budi Santoso",
      cpRole: "client_user",
      access: new Map([
        [ENV_PROD, "admin"],
        [ENV_DEMO, "none"],
      ]),
      needOrg: true,
    });
    expect(steps.map((s) => `${s.type}@${s.env}`)).toEqual([
      "kc_org_ensure@prod",
      "kc_user_ensure@prod",
      "kc_user_set_roles@prod",
      "odoo_user_ensure@prod",
    ]);
    expect(steps[1]!.args).toEqual({ email: "budi@acme.co.id", tenant_id: ACME.id, invite: true, name: "Budi Santoso" });
    expect(steps[2]!.args).toEqual({ email: "budi@acme.co.id", cp_role: "client_user", odoo: "admin" });
    expect(steps[3]!.args).toEqual({ email: "budi@acme.co.id", role: "admin", active: true, name: "Budi Santoso" });
    assertContract("acme-co", steps);
  });
  it("tambah user tanpa akses Odoo: satu kc_user_set_roles di env realm tanpa `odoo`; org sudah ada → tanpa kc_org_ensure", () => {
    const steps = buildAddUserSteps({ ...base, tenant: ACME, name: null, cpRole: "client_admin", access: new Map(), needOrg: false });
    expect(steps.map((s) => s.type)).toEqual(["kc_user_ensure", "kc_user_set_roles"]);
    expect(steps[1]!.args).toEqual({ email: "budi@acme.co.id", cp_role: "client_admin" });
    assertContract("acme-co", steps);
  });
  it("platform: tanpa odoo_* dan tanpa kunci `odoo` (dilarang dispatcher)", () => {
    const steps = buildAddUserSteps({
      ...base,
      tenant: PLATFORM,
      name: null,
      cpRole: "ops",
      access: new Map([[ENV_PROD, "admin"]]),
      needOrg: false,
    });
    expect(steps.map((s) => s.type)).toEqual(["kc_user_ensure", "kc_user_set_roles"]);
    expect(steps[1]!.args).not.toHaveProperty("odoo");
    assertContract("platform", steps);
  });
  it("ubah akses: env aktif → none = cabut role Odoo + odoo_user_ensure active=false (role lama dipertahankan)", () => {
    const steps = buildAccessSteps({
      ...base,
      tenant: ACME,
      cpRole: "client_user",
      access: new Map([
        [ENV_PROD, "none"],
        [ENV_DEMO, "user"],
      ]),
      existing: [{ environmentId: ENV_PROD, status: "active", isAdmin: true }],
    });
    expect(steps).toEqual([
      { type: "kc_user_set_roles", env: "prod", args: { email: "budi@acme.co.id", cp_role: "client_user", odoo: "none" } },
      { type: "kc_user_set_roles", env: "demo", args: { email: "budi@acme.co.id", cp_role: "client_user", odoo: "user" } },
      { type: "odoo_user_ensure", env: "prod", args: { email: "budi@acme.co.id", role: "admin", active: false } },
      { type: "odoo_user_ensure", env: "demo", args: { email: "budi@acme.co.id", role: "user", active: true } },
    ]);
    assertContract("acme-co", steps);
  });
  it("nonaktifkan: kc_user_set_enabled(false) lalu Odoo active=false hanya di env yang aktif", () => {
    const steps = buildDisableSteps({
      realmEnv: "prod",
      email: "budi@acme.co.id",
      tenant: ACME,
      envs,
      existing: [
        { environmentId: ENV_PROD, status: "active", isAdmin: false },
        { environmentId: ENV_DEMO, status: "revoked", isAdmin: false },
      ],
    });
    expect(steps.map((s) => `${s.type}@${s.env}`)).toEqual(["kc_user_set_enabled@prod", "odoo_user_ensure@prod"]);
    expect(steps[0]!.args).toEqual({ email: "budi@acme.co.id", enabled: false });
    expect(steps[1]!.args).toEqual({ email: "budi@acme.co.id", role: "user", active: false });
    assertContract("acme-co", steps);
    expect(buildDisableSteps({ realmEnv: "prod", email: "a@b.co", tenant: PLATFORM, envs: [], existing: [] })).toHaveLength(1);
  });
  it("aktifkan + reset password", () => {
    const en = buildEnableSteps({ ...base, tenant: ACME, cpRole: "client_user", access: new Map([[ENV_DEMO, "user"]]), existing: [] });
    expect(en.map((s) => s.type)).toEqual(["kc_user_set_enabled", "kc_user_set_roles", "odoo_user_ensure"]);
    expect(en[0]!.args).toEqual({ email: "budi@acme.co.id", enabled: true });
    assertContract("acme-co", en);
    const rp = buildPasswordResetSteps({ realmEnv: "staging", email: "budi@acme.co.id" });
    expect(rp).toEqual([{ type: "kc_user_action_email", env: "staging", args: { email: "budi@acme.co.id", action: "UPDATE_PASSWORD" } }]);
    assertContract("acme-co", rp, "staging");
  });
  it("validateChain: tipe di luar allowlist instance / env lintas instance / platform + odoo → ditolak", () => {
    const steps = buildPasswordResetSteps({ realmEnv: "prod", email: "budi@acme.co.id" });
    expect(validateChain("prod", LEGACY_JOB_TYPES, "acme-co", steps)).toEqual({ ok: false, issue: "type_not_allowed", step: 0 });
    expect(validateChain("staging", BRIDGE_JOB_TYPES, "acme-co", steps)).toMatchObject({ ok: false, issue: "env_instance" });
    expect(
      validateChain("prod", BRIDGE_JOB_TYPES, "platform", [
        { type: "kc_user_set_roles", env: "prod", args: { email: "a@b.co", cp_role: "ops", odoo: "none" } },
      ]),
    ).toMatchObject({ ok: false, issue: "odoo_platform" });
    expect(
      validateChain("prod", BRIDGE_JOB_TYPES, "acme-co", [
        { type: "kc_user_set_roles", env: "prod", args: { email: "a@b.co", cp_role: "superadmin" } },
      ]),
    ).toMatchObject({ ok: false, issue: "cp_role_slug" });
    expect(validateChain("prod", BRIDGE_JOB_TYPES, "acme-co", [])).toMatchObject({ ok: false });
  });
  it("orderChain mengikuti after_job_id", () => {
    const mk = (id: string, after: string | null) => ({
      id,
      type: "kc_user_ensure",
      env: "prod",
      status: "queued",
      errorCode: null,
      afterJobId: after,
      createdAt: new Date(0),
      email: null,
      slug: null,
    });
    expect(orderChain([mk("c", "b"), mk("a", null), mk("b", "a")]).map((s) => s.id)).toEqual(["a", "b", "c"]);
    // kepala yang menunggu job rantai lain (dedupe) tetap kepala
    expect(orderChain([mk("y", "x"), mk("z", "y")]).map((s) => s.id)).toEqual(["y", "z"]);
  });
});

describe("kontrak: idempotency, allowlist instance, RESULT keys, nama ASCII", () => {
  it("idempotency_key = <type>:<slug>:<env>:<target>", () => {
    const k = (type: string, args: Record<string, unknown>, slug = "acme-co", env = "prod", dryRun = false) =>
      idempotencyKey({ type: type as never, slug, env: env as never, dryRun, args: args as never });
    expect(k("kc_user_ensure", { email: "a@b.co", tenant_id: ACME.id, invite: true })).toBe("kc_user_ensure:acme-co:prod:a@b.co");
    expect(k("odoo_user_ensure", { email: "a@b.co", role: "user", active: true }, "acme-co", "demo")).toBe("odoo_user_ensure:acme-co:demo:a@b.co");
    expect(k("kc_org_ensure", { tenant_id: ACME.id })).toBe("kc_org_ensure:acme-co:prod:org");
    expect(k("kc_realm_sync", {}, "platform")).toBe("kc_realm_sync:platform:prod:realm");
    expect(k("tenant_suspend", {})).toBe("tenant_suspend:acme-co:prod:tenant");
    // dry-run & tipe plan 05 → tanpa kunci
    expect(k("kc_user_ensure", { email: "a@b.co" }, "acme-co", "prod", true)).toBeNull();
    expect(k("odoo_sso_user", { email: "a@b.co" })).toBeNull();
  });
  it("canonicalJson tidak bergantung urutan kunci (payload jsonb)", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: true } })).toBe(canonicalJson({ a: { c: true, d: [1, { x: 1, y: 2 }] }, b: 1 }));
    expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ a: "1" }));
  });
  it("instanceJobTypes: kosong = 5 tipe lama (prod.conf), daftar → difilter, nama asing dibuang", () => {
    expect(instanceJobTypes(undefined)).toEqual(LEGACY_JOB_TYPES);
    expect(instanceJobTypes("")).toEqual(LEGACY_JOB_TYPES);
    expect(instanceJobTypes(BRIDGE_JOB_TYPES.join(","))).toEqual(BRIDGE_JOB_TYPES);
    expect(instanceJobTypes("kc_user_ensure,rm_rf,odoo_route")).toEqual(["odoo_route", "kc_user_ensure"]);
    expect(userFeatureEnabled(instanceJobTypes(undefined))).toBe(false);
    expect(userFeatureEnabled(instanceJobTypes(USER_FEATURE_TYPES.join(",")))).toBe(true);
    expect(SAAS_P1_JOB_TYPES).toHaveLength(10);
  });
  it("env INFRA_JOBS_TYPES: daftar dipisah koma; karakter lain ditolak", () => {
    const base = {
      DATABASE_URL: "postgresql://u:p@h:5432/d",
      AUTH_SECRET: "x".repeat(40),
      AUTH_URL: "https://cp.example.com",
      AUTH_KEYCLOAK_ID: "control-plane",
      AUTH_KEYCLOAK_SECRET: "y".repeat(20),
      AUTH_KEYCLOAK_ISSUER: "https://auth.example.com/realms/platform",
    };
    expect(webEnvSchema.safeParse({ ...base, INFRA_JOBS_TYPES: "kc_user_ensure,odoo_route" }).success).toBe(true);
    expect(webEnvSchema.safeParse({ ...base, INFRA_JOBS_TYPES: "kc_user_ensure; rm" }).success).toBe(false);
  });
  it("RESULT_KEYS += org roles enabled state tenant (§1.2)", () => {
    for (const k of ["org", "roles", "enabled", "state", "tenant"]) expect(RESULT_KEYS).toContain(k);
    expect(sanitizeResult({ org: "9a1b2c3d-1111-4222-8333-444455556666", roles: "client_user,odoo_access", enabled: "false", secret: "x" })).toEqual({
      org: "9a1b2c3d-1111-4222-8333-444455556666",
      roles: "client_user,odoo_access",
      enabled: "false",
    });
  });
  it("NAME_RE = dispatcher ASCII; non-ASCII DITOLAK (tidak ditransliterasi)", () => {
    expect(NAME_REGEX.source).toBe("^[A-Za-z0-9.,'][A-Za-z0-9 .,'-]{0,99}$");
    expect(asciiName("  Budi   Santoso ")).toBe("Budi Santoso");
    expect(asciiName("O'Neil-Smith Jr.")).toBe("O'Neil-Smith Jr.");
    for (const bad of ["José", "Ñoño", "-Budi", "Budi<script>", "a".repeat(101), "", "名前"]) expect(asciiName(bad)).toBeNull();
  });
  it("kc_realm_sync: slug platform saja; prod apply wajib approve", () => {
    const v = (slug: string, env: "prod" | "staging", dryRun: boolean, args: Record<string, unknown>) =>
      validateJobRequest(env === "staging" ? "staging" : "prod", { type: "kc_realm_sync", slug, env, dryRun, args });
    expect(v("acme-co", "prod", true, {})).toMatchObject({ ok: false, issue: "platform_only" });
    expect(v("platform", "prod", false, {})).toMatchObject({ ok: false, issue: "approve_required" });
    expect(v("platform", "prod", false, { approve: true }).ok).toBe(true);
    expect(v("platform", "prod", true, {}).ok).toBe(true);
    expect(v("platform", "staging", false, {}).ok).toBe(true);
  });
});

describe("kuota rantai (§1.2)", () => {
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
  const step = (type: string, args: Record<string, unknown> = {}) => ({ type: type as never, dryRun: false, args });
  it("seluruh rantai dihitung (bukan per langkah)", () => {
    expect(evaluateChainQuota({ ...zero, totalLastHour: 57 }, [step("kc_user_ensure"), step("kc_user_set_roles"), step("odoo_user_ensure")])).toBeNull();
    expect(evaluateChainQuota({ ...zero, totalLastHour: 58 }, [step("kc_user_ensure"), step("kc_user_set_roles"), step("odoo_user_ensure")])).toBe("total_hour");
  });
  it("kuota per tipe", () => {
    expect(evaluateChainQuota({ ...zero, kcUserDisableLastHour: P1_QUOTA.kcUserDisablePerHour }, [step("kc_user_set_enabled", { enabled: false })])).toBe(
      "kc_user_disable_hour",
    );
    expect(evaluateChainQuota({ ...zero, kcUserDisableLastHour: P1_QUOTA.kcUserDisablePerHour }, [step("kc_user_set_enabled", { enabled: true })])).toBeNull();
    expect(evaluateChainQuota({ ...zero, kcActionEmailLastHour: 20 }, [step("kc_user_action_email")])).toBe("kc_action_email_hour");
    expect(evaluateChainQuota({ ...zero, odooUserLastHour: 60 }, [step("odoo_user_ensure")])).toBe("odoo_user_hour");
    expect(evaluateChainQuota({ ...zero, kcUserLastHour: 59 }, [step("kc_user_ensure"), step("kc_user_set_roles")])).toBe("kc_user_hour");
    expect(evaluateChainQuota({ ...zero, kcRealmSyncLastDay: 10 }, [step("kc_realm_sync")])).toBe("kc_realm_sync_day");
    expect(evaluateChainQuota({ ...zero, tenantStateLastDay: 20 }, [step("tenant_resume")])).toBe("tenant_state_day");
    expect(evaluateChainQuota({ ...zero, actorChainsLastMinute: 10 }, [step("kc_user_action_email")])).toBe("actor_rate");
  });
});

describe("rekonsiliasi dari RESULT (users dari kc_user = sub)", () => {
  const KC = "9a1b2c3d-1111-4222-8333-444455556666";
  const job = (over: Partial<UserReconcileJob>): UserReconcileJob => ({
    id: "3f2c7a9e-1b4d-4e8a-9c3f-5a6b7c8d9e0f",
    type: "kc_user_ensure",
    env: "prod",
    dryRun: false,
    clientId: ACME.id,
    actorUserId: "77777777-7777-4777-8777-777777777777",
    args: { email: "budi@acme.co.id", tenant_id: ACME.id, invite: true, name: "Budi" },
    status: "succeeded",
    result: { realm: "platform", kc_user: KC, created: "1", changed: "1", invite: "1" },
    ...over,
  });
  it("kc_user_ensure sukses → upsert users (sub, email, tenant job, invited_by aktor)", () => {
    expect(planUserReconcile(job({}))).toEqual({
      kind: "user_ensure",
      clientId: ACME.id,
      sub: KC,
      email: "budi@acme.co.id",
      displayName: "Budi",
      invitedBy: "77777777-7777-4777-8777-777777777777",
      adopt: false,
      created: true,
      warnings: [],
    });
  });
  it("F1.4: adopt hanya dari args.adopt === true; created hanya dari RESULT created=1", () => {
    expect(planUserReconcile(job({ args: { email: "budi@acme.co.id", tenant_id: ACME.id, invite: false, adopt: true }, result: { kc_user: KC, created: "0" } }))).toMatchObject({
      kind: "user_ensure",
      adopt: true,
      created: false,
    });
    expect(planUserReconcile(job({ args: { email: "budi@acme.co.id", tenant_id: ACME.id, invite: false, adopt: "true" }, result: { kc_user: KC, created: "yes" } }))).toMatchObject({
      adopt: false,
      created: false,
    });
  });
  it("gagal / dry-run / RESULT mode plan / kc_user tidak valid / tanpa client → tidak mengubah apa pun", () => {
    expect(planUserReconcile(job({ status: "failed" })).kind).toBe("none");
    expect(planUserReconcile(job({ dryRun: true })).kind).toBe("none");
    expect(planUserReconcile(job({ result: { mode: "plan", kc_user: KC } })).kind).toBe("none");
    expect(planUserReconcile(job({ result: { kc_user: "not-a-uuid" } })).kind).toBe("none");
    expect(planUserReconcile(job({ clientId: null })).kind).toBe("none");
  });
  it("kc_user_set_roles → cache role (none dibiarkan)", () => {
    expect(planUserReconcile(job({ type: "kc_user_set_roles", args: { email: "budi@acme.co.id", cp_role: "client_admin", odoo: "user" } }))).toMatchObject({
      kind: "user_role",
      role: "client_admin",
      sub: KC,
    });
    expect(planUserReconcile(job({ type: "kc_user_set_roles", args: { email: "budi@acme.co.id", cp_role: "none" } })).kind).toBe("none");
  });
  it("kc_user_set_enabled → status", () => {
    expect(planUserReconcile(job({ type: "kc_user_set_enabled", args: { email: "budi@acme.co.id", enabled: false } }))).toMatchObject({
      kind: "user_enabled",
      enabled: false,
    });
  });
  it("odoo_user_ensure → tenant_user_access per env job", () => {
    expect(
      planUserReconcile(
        job({ type: "odoo_user_ensure", env: "demo", args: { email: "budi@acme.co.id", role: "admin", active: true }, result: { db: "acme_co_demo", odoo_user: "12", kc_user: KC } }),
      ),
    ).toMatchObject({ kind: "odoo_access", env: "demo", isAdmin: true, active: true, odooUserId: 12, kcUserId: KC });
  });
  it("kc_org_ensure → clients.kc_org_id (hanya UUID)", () => {
    expect(planUserReconcile(job({ type: "kc_org_ensure", args: { tenant_id: ACME.id }, result: { org: KC, realm: "platform" } }))).toMatchObject({
      kind: "org",
      kcOrgId: KC,
    });
    expect(planUserReconcile(job({ type: "kc_org_ensure", args: { tenant_id: ACME.id }, result: { org: "../x" } })).kind).toBe("none");
  });
});

describe("form Users + client", () => {
  const C = ACME.id;
  it("addUser: odoo_<envId> none|user|admin; email dinormalkan; field asing ditolak", () => {
    const r = parseUserForm("addUser", [
      ["clientId", C],
      ["email", " Budi@Acme.co.id "],
      ["name", "Budi"],
      ["cp_role", "client_user"],
      [`odoo_${ENV_PROD}`, "admin"],
      [`odoo_${ENV_DEMO}`, "none"],
    ]);
    expect(r).toEqual({
      success: true,
      data: { clientId: C, email: "budi@acme.co.id", name: "Budi", cp_role: "client_user" },
      odoo: { [ENV_PROD]: "admin", [ENV_DEMO]: "none" },
    });
    expect(parseUserForm("addUser", [["clientId", C], ["email", "a@b.co"], ["cp_role", "client_user"], ["tenant_id", C]]).success).toBe(false);
    expect(parseUserForm("addUser", [["clientId", C], ["email", "a@b.co"], ["cp_role", "root"]]).success).toBe(false);
    expect(parseUserForm("addUser", [["clientId", C], ["email", "a@b.co"], ["cp_role", "client_user"], [`odoo_${ENV_PROD}`, "superuser"]]).success).toBe(false);
    expect(parseUserForm("addUser", [["clientId", C], ["email", "a@b.co"], ["cp_role", "client_user"], ["odoo_not-a-uuid", "user"]]).success).toBe(false);
    expect(
      parseUserForm("addUser", [
        ["clientId", C],
        ["email", "a@b.co"],
        ["cp_role", "client_user"],
        ["email", "b@b.co"],
      ]).success,
    ).toBe(false);
  });
  it("nama non-ASCII → name_invalid (pesan jelas, tidak ditransliterasi)", () => {
    expect(parseUserForm("addUser", [["clientId", C], ["email", "a@b.co"], ["name", "José"], ["cp_role", "client_user"]])).toEqual({
      success: false,
      issue: "name_invalid",
    });
    expect(ACTION_RESULT_TEXT.name_invalid).toMatch(/ASCII/);
  });
  it("disable wajib konfirmasi; passwordReset tidak menerima odoo_*", () => {
    const U = "88888888-8888-4888-8888-888888888888";
    expect(parseUserForm("disableUser", [["userId", U]]).success).toBe(false);
    expect(parseUserForm("disableUser", [["userId", U], ["confirm", "on"]]).success).toBe(true);
    expect(parseUserForm("passwordReset", [["userId", U], [`odoo_${ENV_PROD}`, "user"]]).success).toBe(false);
    expect(parseUserForm("changeAccess", [["userId", U], ["cp_role", "client_user"], [`odoo_${ENV_STG}`, "user"]]).success).toBe(true);
  });
  it("createClient menolak slug reserved `platform`", () => {
    expect(parseForm("createClient", [["slug", "platform"], ["name", "x"]]).success).toBe(false);
    expect(parseForm("createClient", [["slug", "platform-co"], ["name", "x"]]).success).toBe(true);
  });
});

describe("kode umpan balik aksi user (whitelist)", () => {
  it("setiap kode hasil ada di ACTION_RESULT_CODES + punya teks", () => {
    const outs = [
      userOutcomeCode({ ok: true, chainId: "x", jobIds: [] }),
      userOutcomeCode({ ok: false, reason: "authz", denial: "cross_tenant" }),
      userOutcomeCode({ ok: false, reason: "authz", denial: "role_not_allowed" }),
      userOutcomeCode({ ok: false, reason: "authz", denial: "self_action" }),
      userOutcomeCode({ ok: false, reason: "authz", denial: "one_admin" }),
      userOutcomeCode({ ok: false, reason: "authz", denial: "actor_disabled" }),
      userOutcomeCode({ ok: false, reason: "authz", denial: "target_disabled" }),
      userOutcomeCode({ ok: false, reason: "authz", denial: "tenant_inactive" }),
      userOutcomeCode({ ok: false, reason: "precondition", detail: "email_other_tenant" }),
      userOutcomeCode({ ok: false, reason: "precondition", detail: "env_unknown" }),
      userOutcomeCode({ ok: false, reason: "duplicate", existingJobId: "x" }),
      userOutcomeCode({ ok: false, reason: "quota", violation: "kc_user_hour" }),
      userOutcomeCode({ ok: false, reason: "disabled" }),
      userOutcomeCode({ ok: false, reason: "not_found" }),
    ];
    expect(outs).toEqual([
      "queued",
      "cross_tenant",
      "role_not_allowed",
      "self_action",
      "one_admin",
      "forbidden",
      "user_disabled",
      "tenant_inactive",
      "email_other_tenant",
      "invalid",
      "duplicate",
      "quota",
      "disabled",
      "not_found",
    ]);
    for (const o of outs) {
      expect(ACTION_RESULT_CODES).toContain(o);
      expect(ACTION_RESULT_TEXT[o]).toBeTruthy();
    }
  });
});

describe("temuan QA F1 — kontrak adopt (kc_user_ensure v1.2)", () => {
  const args = { email: "lama@bimacreative.tech", tenant_id: PLATFORM.id, invite: false };
  const v = (a: Record<string, unknown>, slug = "platform") => validateJobRequest("prod", { type: "kc_user_ensure", slug, env: "prod", dryRun: false, args: a });
  it("adopt opsional boolean: absen / true / false → valid", () => {
    expect(v(args).ok).toBe(true);
    expect(v({ ...args, adopt: true }).ok).toBe(true);
    expect(v({ ...args, adopt: false }).ok).toBe(true);
    expect(v({ ...args, tenant_id: ACME.id, adopt: true }, "acme-co").ok).toBe(true);
  });
  it("adopt non-boolean → args (JSON true|false wajib)", () => {
    for (const bad of ["true", "false", 1, 0, null, [], {}, "yes"]) expect(v({ ...args, adopt: bad })).toEqual({ ok: false, issue: "args" });
  });
  it(".strict(): kunci asing tetap ditolak; tipe lain tidak menerima adopt", () => {
    expect(v({ ...args, adopt: true, force: true })).toEqual({ ok: false, issue: "args" });
    expect(
      validateJobRequest("prod", { type: "kc_user_set_roles", slug: "platform", env: "prod", dryRun: false, args: { email: "a@b.co", cp_role: "ops", adopt: true } }),
    ).toEqual({ ok: false, issue: "args" });
  });
  it("file job dengan adopt=true lolos validator file (penjaga terakhir sebelum spool)", () => {
    const f = buildJobFile("prod", {
      id: "3f2c7a9e-1b4d-4e8a-9c3f-5a6b7c8d9e0f",
      type: "kc_user_ensure",
      slug: "platform",
      env: "prod",
      dryRun: false,
      actor: "user:6b1f0e2a-4c3d-4e5f-8a9b-0c1d2e3f4a5b",
      createdAt: new Date("2026-10-03T10:00:00Z"),
      args: { ...args, adopt: true },
    });
    expect(f.args).toEqual({ ...args, adopt: true });
  });
  it("chainHasAdopt / chainAdminEmails (F2) murni", () => {
    expect(chainHasAdopt([{ type: "kc_user_ensure", env: "prod", args: { ...args, adopt: true } }])).toBe(true);
    expect(chainHasAdopt([{ type: "kc_user_ensure", env: "prod", args: { ...args, adopt: false } }])).toBe(false);
    expect(chainHasAdopt([{ type: "kc_user_ensure", env: "prod", args }])).toBe(false);
    expect(
      chainAdminEmails([
        { type: "kc_user_set_roles", env: "prod", args: { email: "a@acme.co.id", cp_role: "client_admin", odoo: "user" } },
        { type: "kc_user_set_roles", env: "demo", args: { email: "a@acme.co.id", cp_role: "client_admin", odoo: "none" } },
        { type: "kc_user_set_roles", env: "prod", args: { email: "b@acme.co.id", cp_role: "client_user" } },
      ]),
    ).toEqual(["a@acme.co.id"]);
  });
});

describe("temuan QA F1.2 — aturan pengikatan email", () => {
  const row = (clientId: string | null, role: Role = "client_user", id = "r1") => ({ id, clientId, role });
  it("tenant klien: baris lama NULL / role platform / tenant lain → ditolak; tenant sama → ok", () => {
    expect(emailBindingConflict(ACME, [])).toBeNull();
    expect(emailBindingConflict(ACME, [row(ACME.id)])).toBeNull();
    expect(emailBindingConflict(ACME, [row(null)])).toBe("email_unbound");
    expect(emailBindingConflict(ACME, [row(null, "superadmin")])).toBe("email_unbound");
    expect(emailBindingConflict(ACME, [row(ACME.id, "superadmin")])).toBe("email_platform_role");
    expect(emailBindingConflict(ACME, [row(ACME.id, "ops")])).toBe("email_platform_role");
    expect(emailBindingConflict(ACME, [row(BETA.id)])).toBe("email_other_tenant");
    expect(emailBindingConflict(ACME, [row(PLATFORM.id, "superadmin")])).toBe("email_other_tenant");
  });
  it("platform: baris lama NULL hanya lewat adopt; tenant klien → ditolak; platform sendiri → ok", () => {
    expect(emailBindingConflict(PLATFORM, [row(PLATFORM.id, "superadmin")])).toBeNull();
    expect(emailBindingConflict(PLATFORM, [row(null, "superadmin")])).toBe("email_unbound");
    expect(emailBindingConflict(PLATFORM, [row(ACME.id)])).toBe("email_other_tenant");
  });
  it("adopt: baris target sendiri (NULL) dikecualikan, baris lain tetap dicek", () => {
    expect(emailBindingConflict(PLATFORM, [row(null, "superadmin", "me")], "me")).toBeNull();
    expect(emailBindingConflict(ACME, [row(null, "client_user", "me"), row(null, "client_user", "other")], "me")).toBe("email_unbound");
  });
});

describe("temuan QA F1.4 — adopt (Ikat ke tenant…)", () => {
  const sa = actor(["superadmin"], PLATFORM.id, "sa-sub");
  const legacy = (over: Partial<TargetUser> = {}) => target({ clientId: null, keycloakSub: "legacy-sub", ...over });
  it("hanya superadmin (users:manage): ops / client_admin (juga dengan izin W6) / client_user → forbidden", () => {
    for (const roles of [["ops"], ["client_admin"], ["client_user"], []] as Role[][]) {
      expect(authorizeAdopt(actor(roles, ACME.id), ACME, legacy(), "client_user", NO_ADMIN)).toEqual({ ok: false, reason: "forbidden" });
    }
    expect(authorizeAdopt(actor(["superadmin"], PLATFORM.id, "x", "disabled"), ACME, legacy(), "client_user", NO_ADMIN)).toEqual({
      ok: false,
      reason: "actor_disabled",
    });
  });
  it("platform: role tetap = role cache superadmin/ops; role tenant → ditolak", () => {
    expect(authorizeAdopt(sa, PLATFORM, legacy({ role: "superadmin" }), "superadmin", NO_ADMIN)).toEqual({ ok: true, scope: "all" });
    expect(authorizeAdopt(sa, PLATFORM, legacy({ role: "ops" }), "ops", NO_ADMIN)).toEqual({ ok: true, scope: "all" });
    expect(authorizeAdopt(sa, PLATFORM, legacy({ role: "ops" }), "superadmin", NO_ADMIN)).toEqual({ ok: false, reason: "role_not_allowed" });
    expect(authorizeAdopt(sa, PLATFORM, legacy({ role: "superadmin" }), "none", NO_ADMIN)).toEqual({ ok: false, reason: "role_not_allowed" });
    expect(authorizeAdopt(sa, PLATFORM, legacy({ role: "client_user" }), "client_user", NO_ADMIN)).toEqual({ ok: false, reason: "role_not_allowed" });
    // superadmin mengikat baris lamanya sendiri ke platform (role tetap) → boleh.
    expect(authorizeAdopt(sa, PLATFORM, legacy({ role: "superadmin", keycloakSub: "sa-sub" }), "superadmin", NO_ADMIN)).toEqual({ ok: true, scope: "all" });
  });
  it("tenant klien: hanya client_admin/client_user, tidak pernah untuk role cache superadmin/ops; satu admin", () => {
    expect(authorizeAdopt(sa, ACME, legacy(), "client_user", NO_ADMIN)).toEqual({ ok: true, scope: "all" });
    expect(authorizeAdopt(sa, ACME, legacy({ role: "client_admin" }), "client_admin", NO_ADMIN)).toEqual({ ok: true, scope: "all" });
    for (const r of ["superadmin", "ops"] as const) {
      expect(authorizeAdopt(sa, ACME, legacy({ role: r }), "client_user", NO_ADMIN)).toEqual({ ok: false, reason: "role_not_allowed" });
      expect(authorizeAdopt(sa, ACME, legacy(), r, NO_ADMIN)).toEqual({ ok: false, reason: "role_not_allowed" });
    }
    expect(authorizeAdopt(sa, ACME, legacy(), "none", NO_ADMIN)).toEqual({ ok: false, reason: "role_not_allowed" });
    expect(authorizeAdopt(sa, ACME, legacy(), "client_admin", ONE_ADMIN)).toEqual({ ok: false, reason: "one_admin" });
  });
  it("sudah terikat / tenant terminated / target disabled → ditolak", () => {
    expect(authorizeAdopt(sa, ACME, legacy({ clientId: ACME.id }), "client_user", NO_ADMIN)).toEqual({ ok: false, reason: "already_bound" });
    expect(authorizeAdopt(sa, { ...ACME, terminated: true }, legacy(), "client_user", NO_ADMIN)).toEqual({ ok: false, reason: "tenant_inactive" });
    expect(authorizeAdopt(sa, ACME, legacy({ status: "disabled" }), "client_user", NO_ADMIN)).toEqual({ ok: false, reason: "target_disabled" });
  });
  it("rantai adopt: [org] → kc_user_ensure adopt=true invite=false → kc_user_set_roles (tanpa odoo) — lolos kontrak", () => {
    const st = buildAdoptSteps({ tenant: ACME, realmEnv: "prod", email: "tono@acme.co.id", cpRole: "client_user", needOrg: true });
    expect(st).toEqual([
      { type: "kc_org_ensure", env: "prod", args: { tenant_id: ACME.id } },
      { type: "kc_user_ensure", env: "prod", args: { email: "tono@acme.co.id", tenant_id: ACME.id, invite: false, adopt: true } },
      { type: "kc_user_set_roles", env: "prod", args: { email: "tono@acme.co.id", cp_role: "client_user" } },
    ]);
    assertContract("acme-co", st);
    const sp = buildAdoptSteps({ tenant: PLATFORM, realmEnv: "staging", email: "lama@bimacreative.tech", cpRole: "superadmin", needOrg: false });
    expect(sp.map((x) => x.type)).toEqual(["kc_user_ensure", "kc_user_set_roles"]);
    assertContract("platform", sp, "staging");
  });
  it("form adoptUser: strict, role dari enum", () => {
    const U = "88888888-8888-4888-8888-888888888888";
    expect(parseUserForm("adoptUser", [["userId", U], ["clientId", ACME.id], ["cp_role", "client_user"]]).success).toBe(true);
    expect(parseUserForm("adoptUser", [["userId", U], ["clientId", ACME.id], ["cp_role", "root"]]).success).toBe(false);
    expect(parseUserForm("adoptUser", [["userId", U], ["clientId", ACME.id], ["cp_role", "client_user"], ["adopt", "true"]]).success).toBe(false);
    expect(parseUserForm("adoptUser", [["userId", U], ["clientId", ACME.id], ["cp_role", "client_user"], [`odoo_${ENV_PROD}`, "user"]]).success).toBe(false);
  });
  it("kode umpan balik baru ada di whitelist + punya teks", () => {
    const outs = [
      userOutcomeCode({ ok: false, reason: "precondition", detail: "email_unbound" }),
      userOutcomeCode({ ok: false, reason: "precondition", detail: "email_platform_role" }),
      userOutcomeCode({ ok: false, reason: "authz", denial: "already_bound" }),
      userOutcomeCode({ ok: false, reason: "adopt_forbidden" }),
      userOutcomeCode({ ok: false, reason: "one_admin", conflict: "job" }),
    ];
    expect(outs).toEqual(["email_unbound", "email_platform_role", "already_bound", "forbidden", "one_admin"]);
    for (const o of outs) {
      expect(ACTION_RESULT_CODES).toContain(o);
      expect(ACTION_RESULT_TEXT[o]).toBeTruthy();
    }
  });
});
