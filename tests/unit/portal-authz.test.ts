/**
 * Portal tenant W6 — otorisasi (murni + Server Action dipanggil langsung + inventaris statis gerbang halaman/aksi):
 * - client_admin/client_user hanya punya izin portal (+ dashboard); SEMUA halaman & Server Action platform menolak;
 * - kanal: users:manage_own (client_admin) hanya berlaku di kanal portal; superadmin tidak bertindak lewat portal;
 * - form portal tidak menerima clientId/cp_role (tenant & role dari server); userId tenant lain = not_found (tanpa oracle);
 * - batas user plan (planLimitAllows) dan cakupan portal dari users.client_id (decidePortalScope).
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

class RedirectSignal extends Error {
  constructor(readonly url: string) {
    super(`redirect:${url}`);
  }
}

const h = vi.hoisted(() => ({
  session: null as null | { user: { id: string }; roles: string[] },
  services: {
    portalAddUser: vi.fn(),
    portalChangeAccess: vi.fn(),
    portalSetUserEnabled: vi.fn(),
    portalPasswordReset: vi.fn(),
  },
  assertSameOrigin: vi.fn(async () => true),
  actorFromSession: vi.fn(async () => ({ sub: "6b1f0e2a-4c3d-4e5f-8a9b-0c1d2e3f4a5b", userId: "u1", roles: ["client_admin"] })),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/auth", () => ({ auth: vi.fn(async () => h.session) }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new RedirectSignal(url);
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/db", () => ({ getDb: vi.fn(() => ({})) }));
vi.mock("@/server/boss", () => ({ getSendFn: vi.fn(async () => async () => null) }));
vi.mock("@/env", () => ({
  getWebEnv: () => ({
    INFRA_JOBS_INSTANCE: "prod",
    INFRA_JOBS_TYPES: "kc_org_ensure,kc_user_ensure,kc_user_set_roles,kc_user_set_enabled,kc_user_action_email,odoo_user_ensure",
    AUTH_URL: "https://cp.example.test",
  }),
}));
vi.mock("@/server/context", () => ({
  assertSameOrigin: h.assertSameOrigin,
  actorFromSession: h.actorFromSession,
  requestMeta: vi.fn(async () => ({ ip: null, requestId: null })),
}));
vi.mock("@/jobs/portal", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/jobs/portal")>();
  return { ...orig, ...h.services };
});

import {
  portalAddUserAction,
  portalChangeAccessAction,
  portalDisableUserAction,
  portalEnableUserAction,
  portalPasswordResetAction,
} from "@/app/portal/users/actions";
import { portalOutcomeCode } from "@/jobs/portal";
import { ACTION_RESULT_CODES } from "@/lib/job-list-params";
import { decidePortalScope } from "@/lib/portal";
import { PERMISSIONS, can, landingPath, type Permission, type Role } from "@/lib/roles";
import { authorizeAdopt, authorizeUserMutation, planLimitAllows, type TargetUser, type TenantRef, type UserActorContext } from "@/lib/user-admin";
import { parseUserForm } from "@/lib/user-forms";

const U = "88888888-8888-4888-8888-888888888888";
const E = "77777777-7777-4777-8777-777777777777";
const C = "11111111-1111-4111-8111-111111111111";
const SUB = "6b1f0e2a-4c3d-4e5f-8a9b-0c1d2e3f4a5b";
const fd = (entries: [string, string][]) => {
  const f = new FormData();
  for (const [k, v] of entries) f.append(k, v);
  return f;
};
async function redirectOf(p: Promise<void>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof RedirectSignal) return e.url;
    throw e;
  }
  throw new Error("aksi tidak redirect");
}
const as = (roles: string[] | null) => {
  h.session = roles ? { user: { id: SUB }, roles } : null;
};

const CALLS: [string, (f: FormData) => Promise<void>, () => FormData, keyof typeof h.services][] = [
  ["portalAddUserAction", portalAddUserAction, () => fd([["email", "sari@acme.co.id"], ["name", "Sari"], [`odoo_${E}`, "user"]]), "portalAddUser"],
  ["portalChangeAccessAction", portalChangeAccessAction, () => fd([["userId", U], [`odoo_${E}`, "admin"]]), "portalChangeAccess"],
  ["portalDisableUserAction", portalDisableUserAction, () => fd([["userId", U], ["confirm", "on"]]), "portalSetUserEnabled"],
  ["portalEnableUserAction", portalEnableUserAction, () => fd([["userId", U], [`odoo_${E}`, "none"]]), "portalSetUserEnabled"],
  ["portalPasswordResetAction", portalPasswordResetAction, () => fd([["userId", U]]), "portalPasswordReset"],
];

describe("izin portal & halaman awal", () => {
  it("client_admin: portal:view + portal:admin + users:manage_own + dashboard; client_user: portal:view + dashboard saja", () => {
    const allowed = (r: Role) => (Object.keys(PERMISSIONS) as Permission[]).filter((p) => can([r], p)).sort();
    expect(allowed("client_admin")).toEqual(["dashboard:view", "portal:admin", "portal:view", "users:manage_own"]);
    expect(allowed("client_user")).toEqual(["dashboard:view", "portal:view"]);
    for (const r of ["superadmin", "ops"] as const) {
      expect(can([r], "portal:view")).toBe(false);
      expect(can([r], "portal:admin")).toBe(false);
      expect(can([r], "users:manage_own")).toBe(false);
    }
  });
  it("landingPath: staf → /dashboard, tenant → /portal (staf + role tenant → /dashboard)", () => {
    expect(landingPath(["superadmin"])).toBe("/dashboard");
    expect(landingPath(["ops"])).toBe("/dashboard");
    expect(landingPath(["client_admin"])).toBe("/portal");
    expect(landingPath(["client_user"])).toBe("/portal");
    expect(landingPath(["ops", "client_admin"])).toBe("/dashboard");
    expect(landingPath([])).toBe("/dashboard");
    expect(landingPath(undefined)).toBe("/dashboard");
  });
});

/** Inventaris statis: setiap page/Server Action memanggil gerbang izin literal; role tenant hanya lolos di portal+dashboard. */
describe("inventaris gerbang halaman & Server Action (URL langsung / POST action langsung)", () => {
  const appDir = path.resolve(__dirname, "../../src/app");
  const walk = (d: string): string[] =>
    readdirSync(d).flatMap((n) => {
      const p = path.join(d, n);
      return statSync(p).isDirectory() ? walk(p) : [p];
    });
  const files = walk(appDir);
  const route = (f: string) => "/" + path.relative(appDir, path.dirname(f)).split(path.sep).join("/");
  const PUBLIC_PAGES = new Set(["/", "/login", "/forbidden", "/suspended", "/suspended/[slug]"]);

  it("setiap page.tsx non-publik punya gerbang izin; role tenant hanya lolos di /portal* dan /dashboard*", () => {
    const pages = files.filter((f) => f.endsWith("page.tsx"));
    expect(pages.length).toBeGreaterThan(15);
    for (const f of pages) {
      const r = route(f).replace(/\/$/, "") || "/";
      if (PUBLIC_PAGES.has(r)) continue;
      const src = readFileSync(f, "utf8");
      const m = /require(?:Permission|Portal)\("([a-z_]+:[a-z_]+)"\)/.exec(src);
      expect(m, `${r} tanpa gerbang izin literal`).not.toBeNull();
      const perm = m![1] as Permission;
      expect(Object.keys(PERMISSIONS)).toContain(perm);
      const tenantAllowed = can(["client_admin"], perm) || can(["client_user"], perm);
      if (r.startsWith("/portal")) {
        expect(perm.startsWith("portal:"), r).toBe(true);
      } else if (r.startsWith("/dashboard")) {
        expect(perm, r).toBe("dashboard:view");
      } else {
        expect(tenantAllowed, `${r} (${perm}) terbuka untuk role tenant`).toBe(false);
      }
    }
  });

  it("setiap file \"use server\" platform menolak role tenant; hanya aksi portal memakai users:manage_own", () => {
    const actions = files.filter((f) => /\.(ts|tsx)$/.test(f) && readFileSync(f, "utf8").startsWith('"use server"'));
    expect(actions.length).toBeGreaterThanOrEqual(8);
    for (const f of actions) {
      const r = route(f);
      const src = readFileSync(f, "utf8");
      const perms = [
        ...[...src.matchAll(/requirePermission\("([a-z_]+:[a-z_]+)"\)/g)].map((m) => m[1]!),
        ...[...src.matchAll(/handleBillingAction\("\w+", "([a-z_]+:[a-z_]+)"/g)].map((m) => m[1]!),
      ] as Permission[];
      if (r === "/") continue; // login/logout — tanpa input, tanpa izin
      expect(perms.length, `${r}: tanpa gerbang izin literal`).toBeGreaterThan(0);
      for (const p of perms) {
        if (r === "/portal/users") {
          expect(p).toBe("users:manage_own");
        } else {
          expect(can(["client_admin"], p) || can(["client_user"], p), `${r} (${p}) terbuka untuk role tenant`).toBe(false);
        }
      }
    }
  });
});

describe("Server Action portal dipanggil langsung", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const f of Object.values(h.services)) f.mockResolvedValue({ ok: true, chainId: "c", jobIds: [] });
  });

  it.each(CALLS)("client_user / ops / superadmin → %s ditolak (/forbidden) tanpa layanan; tanpa sesi → /login", async (_n, action, form) => {
    for (const roles of [["client_user"], ["ops"], ["superadmin"], []]) {
      as(roles);
      expect(await redirectOf(action(form()))).toBe("/forbidden");
    }
    as(null);
    expect(await redirectOf(action(form()))).toBe("/login");
    for (const f of Object.values(h.services)) expect(f).not.toHaveBeenCalled();
    expect(h.assertSameOrigin).not.toHaveBeenCalled();
  });

  it.each(CALLS)("client_admin → %s sampai ke layanan portal yang benar (tanpa clientId dari form)", async (_n, action, form, svc) => {
    as(["client_admin"]);
    expect(await redirectOf(action(form()))).toBe("/portal/users?r=queued");
    expect(h.services[svc]).toHaveBeenCalledTimes(1);
    const arg = h.services[svc].mock.calls[0]![2] as Record<string, unknown>;
    expect(arg).not.toHaveProperty("clientId");
    expect(arg).not.toHaveProperty("cpRole");
    expect(arg).not.toHaveProperty("channel"); // kanal ditetapkan lapisan jobs/portal.ts
  });

  it("field asing (clientId / cp_role / tenant) → ?r=invalid tanpa layanan (tenant & role dari server)", async () => {
    as(["client_admin"]);
    const bad: [(f: FormData) => Promise<void>, [string, string][]][] = [
      [portalAddUserAction, [["email", "x@acme.co.id"], ["clientId", C]]],
      [portalAddUserAction, [["email", "x@acme.co.id"], ["cp_role", "client_admin"]]],
      [portalChangeAccessAction, [["userId", U], ["cp_role", "client_admin"]]],
      [portalDisableUserAction, [["userId", U], ["confirm", "on"], ["clientId", C]]],
      [portalPasswordResetAction, [["userId", U], [`odoo_${E}`, "admin"]]],
      [portalAddUserAction, [["email", "x@acme.co.id"], ["email", "y@acme.co.id"]]],
    ];
    for (const [action, entries] of bad) expect(await redirectOf(action(fd(entries)))).toBe("/portal/users?r=invalid");
    for (const f of Object.values(h.services)) expect(f).not.toHaveBeenCalled();
  });

  it("Origin asing → ?r=origin; sesi lama tanpa sub → ?r=reauth", async () => {
    as(["client_admin"]);
    h.assertSameOrigin.mockResolvedValueOnce(false);
    expect(await redirectOf(portalAddUserAction(CALLS[0]![2]()))).toBe("/portal/users?r=origin");
    h.actorFromSession.mockResolvedValueOnce(null as never);
    expect(await redirectOf(portalPasswordResetAction(fd([["userId", U]])))).toBe("/portal/users?r=reauth");
    for (const f of Object.values(h.services)) expect(f).not.toHaveBeenCalled();
  });

  it("hasil layanan → kode whitelist; cross_tenant (userId tenant lain) = not_found (tanpa oracle)", async () => {
    expect(portalOutcomeCode({ ok: false, reason: "authz", denial: "cross_tenant" })).toBe("not_found");
    expect(portalOutcomeCode({ ok: false, reason: "authz", denial: "role_not_allowed" })).toBe("role_not_allowed");
    expect(portalOutcomeCode({ ok: false, reason: "precondition", detail: "plan_limit" })).toBe("plan_limit");
    expect(portalOutcomeCode({ ok: false, reason: "authz", denial: "self_action" })).toBe("self_action");
    as(["client_admin"]);
    h.services.portalChangeAccess.mockResolvedValueOnce({ ok: false, reason: "authz", denial: "cross_tenant" });
    expect(await redirectOf(portalChangeAccessAction(fd([["userId", U]])))).toBe("/portal/users?r=not_found");
    for (const c of ["not_found", "plan_limit", "role_not_allowed", "self_action"]) expect(ACTION_RESULT_CODES).toContain(c);
  });
});

describe("authorizeUserMutation — kanal portal (W6)", () => {
  const ACME: TenantRef = { id: C, slug: "acme-co", isPlatform: false, terminated: false };
  const BETA: TenantRef = { id: "22222222-2222-4222-8222-222222222222", slug: "beta-co", isPlatform: false, terminated: false };
  const PLATFORM: TenantRef = { id: "00000000-0000-4000-8000-000000000000", slug: "platform", isPlatform: true, terminated: false };
  const actor = (roles: Role[], clientId: string | null, sub = "ca-sub"): UserActorContext => ({ sub, roles, userId: "x", clientId, status: "active" });
  const target = (o: Partial<TargetUser> = {}): TargetUser => ({ id: U, keycloakSub: "t", email: "t@acme.co.id", role: "client_user", status: "active", clientId: C, ...o });
  const portal = { otherActiveAdmins: 1, channel: "portal" as const };
  const ca = actor(["client_admin"], C);

  it("superadmin lewat kanal portal → forbidden; client_admin lewat kanal platform → forbidden", () => {
    expect(authorizeUserMutation(actor(["superadmin"], PLATFORM.id), ACME, { kind: "add", cpRole: "client_user" }, portal)).toEqual({ ok: false, reason: "forbidden" });
    expect(authorizeUserMutation(ca, ACME, { kind: "add", cpRole: "client_user" }, { otherActiveAdmins: 1 })).toEqual({ ok: false, reason: "forbidden" });
    expect(authorizeUserMutation(actor(["client_user"], C), ACME, { kind: "add", cpRole: "client_user" }, portal)).toEqual({ ok: false, reason: "forbidden" });
  });
  it("hanya client_user yang boleh diberikan; client_admin/superadmin/ops/none → role_not_allowed (eskalasi)", () => {
    expect(authorizeUserMutation(ca, ACME, { kind: "add", cpRole: "client_user" }, portal)).toEqual({ ok: true, scope: "own" });
    for (const r of ["client_admin", "superadmin", "ops", "none"] as const) {
      expect(authorizeUserMutation(ca, ACME, { kind: "add", cpRole: r }, portal)).toEqual({ ok: false, reason: "role_not_allowed" });
      expect(authorizeUserMutation(ca, ACME, { kind: "change_access", target: target(), cpRole: r }, portal)).toEqual({ ok: false, reason: "role_not_allowed" });
    }
  });
  it("target harus tenant-user tenant sendiri: admin lain / staf platform → role_not_allowed; tenant lain → cross_tenant", () => {
    for (const m of [
      { kind: "disable", target: target({ role: "client_admin", keycloakSub: "other-admin" }) },
      { kind: "password_reset", target: target({ role: "client_admin", keycloakSub: "other-admin" }) },
      { kind: "enable", target: target({ role: "client_admin", status: "disabled" }), cpRole: "client_admin" },
      { kind: "disable", target: target({ role: "ops" }) },
    ] as const) {
      expect(authorizeUserMutation(ca, ACME, m, portal)).toEqual({ ok: false, reason: "role_not_allowed" });
    }
    expect(authorizeUserMutation(ca, BETA, { kind: "disable", target: target({ clientId: BETA.id }) }, portal)).toEqual({ ok: false, reason: "cross_tenant" });
    expect(authorizeUserMutation(ca, ACME, { kind: "disable", target: target({ clientId: BETA.id }) }, portal)).toEqual({ ok: false, reason: "cross_tenant" });
    expect(authorizeUserMutation(actor(["client_admin"], null), ACME, { kind: "add", cpRole: "client_user" }, portal)).toEqual({ ok: false, reason: "cross_tenant" });
  });
  it("diri sendiri → self_action; aktor disabled → actor_disabled; tenant terminated → tenant_inactive", () => {
    const self = target({ keycloakSub: "ca-sub", role: "client_admin" });
    expect(authorizeUserMutation(ca, ACME, { kind: "disable", target: self }, portal)).toEqual({ ok: false, reason: "self_action" });
    expect(authorizeUserMutation(ca, ACME, { kind: "change_access", target: self, cpRole: "client_user" }, portal)).toEqual({ ok: false, reason: "self_action" });
    expect(authorizeUserMutation({ ...ca, status: "disabled" }, ACME, { kind: "add", cpRole: "client_user" }, portal)).toEqual({ ok: false, reason: "actor_disabled" });
    expect(authorizeUserMutation(ca, { ...ACME, terminated: true }, { kind: "add", cpRole: "client_user" }, portal)).toEqual({ ok: false, reason: "tenant_inactive" });
  });
  it("adopt tidak pernah lewat portal (bahkan superadmin)", () => {
    const legacy = target({ clientId: null });
    expect(authorizeAdopt(actor(["superadmin"], PLATFORM.id), ACME, legacy, "client_user", { otherActiveAdmins: 0, channel: "portal" })).toEqual({ ok: false, reason: "forbidden" });
    expect(authorizeAdopt(ca, ACME, legacy, "client_user", { otherActiveAdmins: 0, channel: "portal" })).toEqual({ ok: false, reason: "forbidden" });
  });
});

describe("batas user plan & cakupan portal", () => {
  it("planLimitAllows: used + 1 ≤ max; tanpa langganan / tanpa batas → selalu boleh", () => {
    const l = { kind: "limited" as const, planCode: "odoo-shared-s", maxUsers: 5 };
    expect(planLimitAllows(l, 4)).toBe(true);
    expect(planLimitAllows(l, 5)).toBe(false);
    expect(planLimitAllows(l, 9)).toBe(false);
    expect(planLimitAllows({ kind: "unlimited", planCode: "odoo-dedicated" }, 1000)).toBe(true);
    expect(planLimitAllows({ kind: "no_subscription" }, 1000)).toBe(true);
  });
  it("decidePortalScope: dari users.client_id saja", () => {
    const T = { id: C, slug: "acme-co", name: "Acme", status: "active", isPlatform: false, terminatedAt: null };
    const row = { id: "u1", clientId: C, status: "active", role: "client_admin" as const };
    expect(decidePortalScope(row, T)).toEqual({ kind: "ok", userId: "u1", tenant: T });
    expect(decidePortalScope(null, null)).toEqual({ kind: "unbound" });
    expect(decidePortalScope({ ...row, clientId: null }, null)).toEqual({ kind: "unbound" });
    expect(decidePortalScope({ ...row, status: "disabled" }, T)).toEqual({ kind: "disabled" });
    expect(decidePortalScope(row, { ...T, isPlatform: true })).toEqual({ kind: "unbound" });
    expect(decidePortalScope(row, { ...T, id: "22222222-2222-4222-8222-222222222222" })).toEqual({ kind: "unbound" });
    expect(decidePortalScope(row, { ...T, status: "suspended" }).kind).toBe("ok");
    expect(decidePortalScope(row, { ...T, status: "terminated" }).kind).toBe("terminated");
  });
  it("form portal: nama non-ASCII ditolak; odoo_* hanya di tambah/ubah akses/aktifkan", () => {
    expect(parseUserForm("portalAddUser", fd([["email", "x@acme.co.id"], ["name", "Ñandú"]]).entries())).toEqual({ success: false, issue: "name_invalid" });
    expect(parseUserForm("portalAddUser", fd([["email", "X@Acme.co.id"]]).entries())).toMatchObject({ success: true, data: { email: "x@acme.co.id" } });
    expect(parseUserForm("disableUser", fd([["userId", U], ["confirm", "on"], [`odoo_${E}`, "none"]]).entries())).toEqual({ success: false, issue: "invalid" });
  });
});
