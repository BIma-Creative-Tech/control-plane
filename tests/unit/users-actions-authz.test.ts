/**
 * Temuan QA F1.3 — client_admin memanggil Server Action Users LANGSUNG (POST action id, tanpa UI) harus ditolak
 * sebelum menyentuh layanan/DB: `users:manage_own` default-deny sampai portal tenant (W6). Kontrol positif:
 * superadmin melewati gerbang izin yang sama dan sampai ke layanan.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

class RedirectSignal extends Error {
  constructor(readonly url: string) {
    super(`redirect:${url}`);
  }
}

const h = vi.hoisted(() => ({
  session: null as null | { user: { id: string }; roles: string[] },
  services: {
    addUser: vi.fn(),
    adoptUser: vi.fn(),
    changeUserAccess: vi.fn(),
    setUserEnabled: vi.fn(),
    sendPasswordReset: vi.fn(),
  },
  assertSameOrigin: vi.fn(async () => true),
  actorFromSession: vi.fn(async () => ({ sub: "6b1f0e2a-4c3d-4e5f-8a9b-0c1d2e3f4a5b", userId: null, roles: ["superadmin"] })),
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
vi.mock("@/jobs/users", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/jobs/users")>();
  return { ...orig, ...h.services };
});

import {
  addUserAction,
  adoptUserAction,
  changeUserAccessAction,
  disableUserAction,
  enableUserAction,
  passwordResetAction,
} from "@/app/users/actions";

const U = "88888888-8888-4888-8888-888888888888";
const C = "11111111-1111-4111-8111-111111111111";
const fd = (entries: [string, string][]) => {
  const f = new FormData();
  for (const [k, v] of entries) f.append(k, v);
  return f;
};
const CALLS: [string, (f: FormData) => Promise<void>, FormData][] = [
  ["addUserAction", addUserAction, fd([["clientId", C], ["email", "x@acme.co.id"], ["cp_role", "client_user"]])],
  ["changeUserAccessAction", changeUserAccessAction, fd([["userId", U], ["cp_role", "client_user"]])],
  ["disableUserAction", disableUserAction, fd([["userId", U], ["confirm", "on"]])],
  ["enableUserAction", enableUserAction, fd([["userId", U]])],
  ["passwordResetAction", passwordResetAction, fd([["userId", U]])],
  ["adoptUserAction", adoptUserAction, fd([["userId", U], ["clientId", C], ["cp_role", "client_user"]])],
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

describe("Server Action Users dipanggil langsung (F1.3)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const f of Object.values(h.services)) f.mockResolvedValue({ ok: true, chainId: "c", jobIds: [] });
  });

  it.each(CALLS)("client_admin → %s ditolak (/forbidden) tanpa memanggil layanan", async (_name, action, form) => {
    h.session = { user: { id: "6b1f0e2a-4c3d-4e5f-8a9b-0c1d2e3f4a5b" }, roles: ["client_admin"] };
    expect(await redirectOf(action(form))).toBe("/forbidden");
    for (const f of Object.values(h.services)) expect(f).not.toHaveBeenCalled();
    expect(h.assertSameOrigin).not.toHaveBeenCalled();
    expect(h.actorFromSession).not.toHaveBeenCalled();
  });

  it.each(CALLS)("client_user / ops → %s ditolak; tanpa sesi → /login", async (_name, action, form) => {
    for (const roles of [["client_user"], ["ops"], ["client_admin", "client_user"]]) {
      h.session = { user: { id: "6b1f0e2a-4c3d-4e5f-8a9b-0c1d2e3f4a5b" }, roles };
      expect(await redirectOf(action(form))).toBe("/forbidden");
    }
    h.session = null;
    expect(await redirectOf(action(form))).toBe("/login");
    for (const f of Object.values(h.services)) expect(f).not.toHaveBeenCalled();
  });

  it.each(CALLS)("kontrol positif: superadmin → %s sampai ke layanan", async (_name, action, form) => {
    h.session = { user: { id: "6b1f0e2a-4c3d-4e5f-8a9b-0c1d2e3f4a5b" }, roles: ["superadmin"] };
    expect(await redirectOf(action(form))).toMatch(/^\/users\?r=queued/);
    expect(Object.values(h.services).filter((f) => f.mock.calls.length > 0)).toHaveLength(1);
  });
});
