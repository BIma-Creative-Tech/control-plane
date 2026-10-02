/**
 * W5 — Server Action Tenant/Realm dipanggil LANGSUNG (POST action id, tanpa UI): hanya superadmin yang sampai ke
 * layanan; ops/klien → /forbidden sebelum Origin/DB/layanan; konfirmasi & form tak valid ditolak sebelum layanan.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

class RedirectSignal extends Error {
  constructor(readonly url: string) {
    super(`redirect:${url}`);
  }
}

const C = "11111111-1111-4111-8111-111111111111";
const J = "22222222-2222-4222-8222-222222222222";

const h = vi.hoisted(() => ({
  session: null as null | { user: { id: string }; roles: string[] },
  services: {
    onboardTenant: vi.fn(),
    setTenantState: vi.fn(),
    retryChainFrom: vi.fn(),
    requestRealmSync: vi.fn(),
  },
  assertSameOrigin: vi.fn(async () => true),
  actorFromSession: vi.fn(async () => ({ sub: "6b1f0e2a-4c3d-4e5f-8a9b-0c1d2e3f4a5b", userId: null, roles: ["superadmin"] })),
}));

/** DB palsu: select().from().innerJoin?().where().limit() → [{ slug }]. */
function fakeDb() {
  const q = {
    from: () => q,
    innerJoin: () => q,
    where: () => q,
    limit: async () => [{ slug: "acme-co" }],
  };
  return { select: () => q };
}

vi.mock("server-only", () => ({}));
vi.mock("@/auth", () => ({ auth: vi.fn(async () => h.session) }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new RedirectSignal(url);
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/db", () => ({ getDb: vi.fn(() => fakeDb()) }));
vi.mock("@/server/boss", () => ({ getSendFn: vi.fn(async () => async () => null) }));
vi.mock("@/env", () => ({
  getWebEnv: () => ({ INFRA_JOBS_INSTANCE: "prod", INFRA_JOBS_TYPES: undefined, AUTH_URL: "https://cp.example.test" }),
}));
vi.mock("@/server/context", () => ({
  assertSameOrigin: h.assertSameOrigin,
  actorFromSession: h.actorFromSession,
  requestMeta: vi.fn(async () => ({ ip: null, requestId: null })),
}));
vi.mock("@/jobs/tenants", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/jobs/tenants")>();
  return { ...orig, ...h.services };
});

import { onboardTenantAction, retryChainStepAction, tenantStateAction } from "@/app/clients/actions";
import { realmSyncApplyAction, realmSyncPlanAction } from "@/app/realm/actions";

const fd = (entries: [string, string][]) => {
  const f = new FormData();
  for (const [k, v] of entries) f.append(k, v);
  return f;
};
const onboardForm = () =>
  fd([
    ["slug", "acme-co"],
    ["name", "Acme"],
    ["admin_email", "admin@acme.co.id"],
    ["admin_name", "Budi"],
  ]);
const CALLS: [string, (f: FormData) => Promise<void>, () => FormData][] = [
  ["onboardTenantAction", onboardTenantAction, onboardForm],
  ["tenantStateAction(suspend)", tenantStateAction, () => fd([["clientId", C], ["action", "suspend"], ["confirm", "acme-co"]])],
  ["tenantStateAction(resume)", tenantStateAction, () => fd([["clientId", C], ["action", "resume"], ["confirm", "acme-co"]])],
  ["retryChainStepAction", retryChainStepAction, () => fd([["jobId", J]])],
  ["realmSyncPlanAction", realmSyncPlanAction, () => fd([])],
  ["realmSyncApplyAction", realmSyncApplyAction, () => fd([["confirm", "platform"], ["approve", "on"]])],
];

async function redirectOf(p: Promise<void>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof RedirectSignal) return e.url;
    throw e;
  }
  throw new Error("aksi tidak redirect");
}

const SUB = "6b1f0e2a-4c3d-4e5f-8a9b-0c1d2e3f4a5b";

describe("Server Action Tenant/Realm — otorisasi", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const f of Object.values(h.services)) f.mockResolvedValue({ ok: true, chainId: "33333333-3333-4333-8333-333333333333", jobIds: [], clientId: C });
  });

  it.each(CALLS)("ops / client_admin / client_user → %s ditolak (/forbidden) tanpa Origin/aktor/layanan", async (_n, action, form) => {
    for (const roles of [["ops"], ["client_admin"], ["client_user"], ["ops", "client_admin"]]) {
      h.session = { user: { id: SUB }, roles };
      expect(await redirectOf(action(form()))).toBe("/forbidden");
    }
    h.session = null;
    expect(await redirectOf(action(form()))).toBe("/login");
    for (const f of Object.values(h.services)) expect(f).not.toHaveBeenCalled();
    expect(h.assertSameOrigin).not.toHaveBeenCalled();
    expect(h.actorFromSession).not.toHaveBeenCalled();
  });

  it.each(CALLS)("kontrol positif: superadmin → %s sampai ke layanan tepat sekali", async (_n, action, form) => {
    h.session = { user: { id: SUB }, roles: ["superadmin"] };
    const url = await redirectOf(action(form()));
    expect(url).toMatch(/\?r=queued&chain=/);
    expect(Object.values(h.services).filter((f) => f.mock.calls.length > 0)).toHaveLength(1);
  });

  it("Origin asing → ?r=origin tanpa layanan", async () => {
    h.session = { user: { id: SUB }, roles: ["superadmin"] };
    h.assertSameOrigin.mockResolvedValueOnce(false);
    expect(await redirectOf(onboardTenantAction(onboardForm()))).toBe("/clients?r=origin");
    for (const f of Object.values(h.services)) expect(f).not.toHaveBeenCalled();
  });

  it("form tak valid ditolak sebelum layanan: slug platform, host lintas env, field asing", async () => {
    h.session = { user: { id: SUB }, roles: ["superadmin"] };
    const f1 = onboardForm();
    f1.set("slug", "platform");
    expect(await redirectOf(onboardTenantAction(f1))).toBe("/clients?r=slug_reserved");
    const f2 = onboardForm();
    f2.set("prod_host", "acme.staging.bimacreative.tech");
    expect(await redirectOf(onboardTenantAction(f2))).toBe("/clients?r=host_invalid");
    const f3 = fd([["clientId", C], ["action", "suspend"], ["confirm", "acme-co"], ["env", "prod"]]);
    expect(await redirectOf(tenantStateAction(f3))).toBe("/clients?r=invalid");
    expect(await redirectOf(realmSyncPlanAction(fd([["dry_run", "false"]])))).toBe("/realm?r=invalid");
    for (const f of Object.values(h.services)) expect(f).not.toHaveBeenCalled();
  });

  it("konfirmasi suspend & approve realm diteruskan apa adanya ke layanan (layanan yang memutuskan)", async () => {
    h.session = { user: { id: SUB }, roles: ["superadmin"] };
    h.services.setTenantState.mockResolvedValueOnce({ ok: false, reason: "confirm" });
    expect(await redirectOf(tenantStateAction(fd([["clientId", C], ["action", "suspend"], ["confirm", "acme"]])))).toBe("/clients/acme-co?r=confirm");
    expect(h.services.setTenantState).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ confirm: "acme", action: "suspend", clientId: C }));
    h.services.requestRealmSync.mockResolvedValueOnce({ ok: false, reason: "realm", code: "approve_required" });
    expect(await redirectOf(realmSyncApplyAction(fd([["confirm", "platform"]])))).toBe("/realm?r=approve_required");
    expect(h.services.requestRealmSync).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ mode: "apply", confirmRealm: "platform", approveChecked: false }),
    );
  });
});
