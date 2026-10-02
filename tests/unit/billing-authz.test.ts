/**
 * ADR 0018 W5 — izin billing (default-deny): lihat superadmin+ops, mutasi superadmin, tandai lunas superadmin+ops
 * (`invoices:confirm`), role client tidak punya akses apa pun di sini (portal W6 kemudian). Server Action dipanggil
 * LANGSUNG (tanpa UI) ditolak sebelum menyentuh layanan; layanan menolak ulang (pertahanan berlapis). Form Zod `.strict()`.
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
    createSubscription: vi.fn(),
    goLiveSubscription: vi.fn(),
    terminateSubscription: vi.fn(),
    setSubscriptionPrice: vi.fn(),
    issueInvoice: vi.fn(),
    voidInvoice: vi.fn(),
    markInvoicePaid: vi.fn(),
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
  getWebEnv: () => ({ INFRA_JOBS_INSTANCE: "prod", INFRA_JOBS_TYPES: "tenant_suspend,tenant_resume", AUTH_URL: "https://cp.example.test" }),
}));
vi.mock("@/server/context", () => ({
  assertSameOrigin: h.assertSameOrigin,
  actorFromSession: h.actorFromSession,
  requestMeta: vi.fn(async () => ({ ip: null, requestId: null })),
}));
vi.mock("@/billing/service", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/billing/service")>();
  return { ...orig, ...h.services };
});

import { issueInvoiceAction, markInvoicePaidAction, voidInvoiceAction } from "@/app/invoices/actions";
import { createSubscriptionAction, goLiveAction, setSubscriptionPriceAction, terminateSubscriptionAction } from "@/app/subscriptions/actions";
import * as billingService from "@/billing/service";
import { billingFormSchemas, parseBillingForm } from "@/lib/billing-forms";
import { ACTION_RESULT_CODES } from "@/lib/job-list-params";
import { PERMISSIONS, ROLES, can } from "@/lib/roles";

const ID = "88888888-8888-4888-8888-888888888888";
const C = "11111111-1111-4111-8111-111111111111";
const fd = (entries: [string, string][]) => {
  const f = new FormData();
  for (const [k, v] of entries) f.append(k, v);
  return f;
};

type Call = [string, (f: FormData) => Promise<void>, () => FormData, keyof typeof h.services];
const MANAGE: Call[] = [
  ["createSubscriptionAction", createSubscriptionAction, () => fd([["clientId", C], ["planId", ID]]), "createSubscription"],
  ["goLiveAction", goLiveAction, () => fd([["subscriptionId", ID], ["goLiveAt", "2026-10-01"]]), "goLiveSubscription"],
  ["terminateSubscriptionAction", terminateSubscriptionAction, () => fd([["subscriptionId", ID], ["confirm", "on"]]), "terminateSubscription"],
  [
    "setSubscriptionPriceAction",
    setSubscriptionPriceAction,
    () => fd([["subscriptionId", ID], ["price_amount", "2500000"], ["price_currency", "IDR"]]),
    "setSubscriptionPrice",
  ],
  [
    "issueInvoiceAction",
    issueInvoiceAction,
    () => fd([["clientId", C], ["subscriptionId", ""], ["kind", "implementation"], ["amount", "1500000"], ["dueAt", "2026-10-17"]]),
    "issueInvoice",
  ],
  ["voidInvoiceAction", voidInvoiceAction, () => fd([["invoiceId", ID], ["reason", "salah nominal"]]), "voidInvoice"],
];
const CONFIRM: Call = [
  "markInvoicePaidAction",
  markInvoicePaidAction,
  () => fd([["invoiceId", ID], ["paidAt", "2026-10-01"], ["paymentReference", "BCA 123"], ["proofReference", "mutasi 2026-10-01"]]),
  "markInvoicePaid",
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

const as = (roles: string[]) => {
  h.session = { user: { id: "6b1f0e2a-4c3d-4e5f-8a9b-0c1d2e3f4a5b" }, roles };
};

describe("peta izin billing (default-deny)", () => {
  it("billing:view = superadmin+ops; billing:manage = superadmin; invoices:confirm tetap superadmin+ops", () => {
    expect(PERMISSIONS["billing:view"]).toEqual(["superadmin", "ops"]);
    expect(PERMISSIONS["billing:manage"]).toEqual(["superadmin"]);
    expect(PERMISSIONS["invoices:confirm"]).toEqual(["superadmin", "ops"]);
  });
  it("role client tidak punya izin billing apa pun", () => {
    for (const r of ["client_admin", "client_user"] as const) {
      for (const p of ["billing:view", "billing:manage", "invoices:confirm"] as const) expect(can([r], p)).toBe(false);
    }
    expect(can([], "billing:view")).toBe(false);
    expect(ROLES).toHaveLength(4);
  });
});

describe("Server Action billing dipanggil langsung", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const f of Object.values(h.services)) f.mockResolvedValue({ ok: true, id: ID, jobIds: [] });
  });

  it.each(MANAGE)("ops/client → %s ditolak (/forbidden) tanpa memanggil layanan", async (_n, action, form) => {
    for (const roles of [["ops"], ["client_admin"], ["client_user"], ["client_admin", "client_user"]]) {
      as(roles);
      expect(await redirectOf(action(form()))).toBe("/forbidden");
    }
    h.session = null;
    expect(await redirectOf(action(form()))).toBe("/login");
    for (const f of Object.values(h.services)) expect(f).not.toHaveBeenCalled();
    expect(h.actorFromSession).not.toHaveBeenCalled();
  });

  it.each(MANAGE)("superadmin → %s sampai ke layanan yang benar", async (_n, action, form, svc) => {
    as(["superadmin"]);
    expect(await redirectOf(action(form()))).toMatch(/^\/(subscriptions|invoices)\?r=created$/);
    expect(h.services[svc]).toHaveBeenCalledTimes(1);
  });

  it("tandai lunas: client ditolak; ops & superadmin sampai ke layanan", async () => {
    const [, action, form, svc] = CONFIRM;
    for (const roles of [["client_admin"], ["client_user"]]) {
      as(roles);
      expect(await redirectOf(action(form()))).toBe("/forbidden");
    }
    expect(h.services[svc]).not.toHaveBeenCalled();
    for (const roles of [["ops"], ["superadmin"]]) {
      as(roles);
      expect(await redirectOf(action(form()))).toBe("/invoices?r=created");
    }
    expect(h.services[svc]).toHaveBeenCalledTimes(2);
  });

  it("Origin asing → ?r=origin; field asing → ?r=invalid; sesi lama → ?r=reauth (layanan tidak dipanggil)", async () => {
    as(["superadmin"]);
    h.assertSameOrigin.mockResolvedValueOnce(false);
    expect(await redirectOf(goLiveAction(fd([["subscriptionId", ID], ["goLiveAt", "2026-10-01"], ["back", "acme-co"]])))).toBe(
      "/subscriptions?tenant=acme-co&r=origin",
    );
    expect(await redirectOf(goLiveAction(fd([["subscriptionId", ID], ["goLiveAt", "2026-10-01"], ["status", "active"]])))).toBe(
      "/subscriptions?r=invalid",
    );
    h.actorFromSession.mockResolvedValueOnce(null as never);
    expect(await redirectOf(voidInvoiceAction(fd([["invoiceId", ID], ["reason", "dobel"]])))).toBe("/invoices?r=reauth");
    expect(await redirectOf(voidInvoiceAction(fd([["invoiceId", ID], ["reason", "dobel"], ["back", "../x"]])))).toBe("/invoices?r=created");
    expect(h.services.goLiveSubscription).not.toHaveBeenCalled();
  });

  it("hasil layanan dipetakan ke kode whitelist", async () => {
    as(["superadmin"]);
    h.services.goLiveSubscription.mockResolvedValueOnce({ ok: false, reason: "billing_status" });
    expect(await redirectOf(goLiveAction(fd([["subscriptionId", ID], ["goLiveAt", "2026-10-01"]])))).toBe("/subscriptions?r=billing_status");
    h.services.markInvoicePaid.mockResolvedValueOnce({ ok: true, id: ID, jobIds: ["j1"] });
    expect(await redirectOf(markInvoicePaidAction(CONFIRM[2]()))).toBe("/invoices?r=queued");
  });
});

describe("layanan billing menolak ulang tanpa izin (sebelum menyentuh DB)", () => {
  const db = {} as never;
  const base = (roles: string[]) => ({
    actor: { sub: "6b1f0e2a-4c3d-4e5f-8a9b-0c1d2e3f4a5b", userId: null, roles: roles as never },
    meta: { ip: null, requestId: null },
    instance: "prod" as const,
    allowedTypes: [],
    send: async () => null,
  });
  it("ops tidak bisa membuat/Go-live/terbitkan/void; client tidak bisa tandai lunas", async () => {
    // Fungsi asli (bukan mock) — impor ulang tanpa mock lewat importActual.
    const real = await vi.importActual<typeof billingService>("@/billing/service");
    expect(await real.createSubscription(db, base(["ops"]), { clientId: C, planId: ID })).toEqual({ ok: false, reason: "forbidden" });
    expect(await real.goLiveSubscription(db, base(["ops"]), { subscriptionId: ID, goLiveAt: "2026-10-01" })).toEqual({ ok: false, reason: "forbidden" });
    expect(await real.terminateSubscription(db, base(["ops"]), { subscriptionId: ID })).toEqual({ ok: false, reason: "forbidden" });
    for (const roles of [["ops"], ["client_admin"], ["client_user"]]) {
      expect(await real.setSubscriptionPrice(db, base(roles), { subscriptionId: ID, priceAmount: "1", priceCurrency: "IDR" })).toEqual({ ok: false, reason: "forbidden" });
    }
    expect(
      await real.issueInvoice(db, base(["ops"]), { clientId: C, kind: "implementation", amount: "1", dueAt: "2026-10-01" }),
    ).toEqual({ ok: false, reason: "forbidden" });
    expect(await real.voidInvoice(db, base(["ops"]), { invoiceId: ID, reason: "x y z" })).toEqual({ ok: false, reason: "forbidden" });
    for (const roles of [["client_admin"], ["client_user"], []]) {
      expect(
        await real.markInvoicePaid(db, base(roles), { invoiceId: ID, paidAt: "2026-10-01", paymentReference: "a", proofReference: "b" }),
      ).toEqual({ ok: false, reason: "forbidden" });
    }
  });

  it("billingOutcomeCode selalu menghasilkan kode yang ada di whitelist", async () => {
    const real = await vi.importActual<typeof billingService>("@/billing/service");
    const reasons = ["forbidden", "not_found", "invalid", "tenant_inactive", "plan_inactive", "service_exists", "billing_status", "future_date", "exists", "invoice_state"];
    for (const reason of reasons) {
      expect(ACTION_RESULT_CODES).toContain(real.billingOutcomeCode({ ok: false, reason } as never));
    }
    expect(real.billingOutcomeCode({ ok: false, reason: "quota", detail: "tenant_state_day" })).toBe("quota");
    expect(real.billingOutcomeCode({ ok: false, reason: "error", message: "pg 23505" })).toBe("error");
    expect(real.billingOutcomeCode({ ok: true, id: ID, jobIds: [] })).toBe("created");
  });
});

describe("form billing (.strict)", () => {
  const ok = <N extends keyof typeof billingFormSchemas>(n: N, e: [string, string][]) => parseBillingForm(n, e).success;
  it("menerima input valid", () => {
    expect(ok("createSubscription", [["clientId", C], ["planId", ID], ["notes", "kontrak 2026\nbaris 2"]])).toBe(true);
    expect(ok("issueInvoice", [["clientId", C], ["subscriptionId", ID], ["kind", "maintenance"], ["amount", "0.5"], ["dueAt", "2028-02-29"]])).toBe(true);
    expect(ok("markInvoicePaid", [["invoiceId", ID], ["paidAt", "2026-10-01"], ["paymentReference", "BCA/123"], ["proofReference", "email 1 Okt"]])).toBe(true);
  });
  it.each([
    ["createSubscription", [["clientId", C], ["planId", ID], ["status", "active"]]],
    ["createSubscription", [["clientId", "x"], ["planId", ID]]],
    ["goLive", [["subscriptionId", ID], ["goLiveAt", "2026-02-30"]]],
    ["goLive", [["subscriptionId", ID], ["goLiveAt", "03/10/2026"]]],
    ["terminateSubscription", [["subscriptionId", ID]]],
    ["issueInvoice", [["clientId", C], ["kind", "maintenance"], ["amount", "1.000.000"], ["dueAt", "2026-10-01"]]],
    ["issueInvoice", [["clientId", C], ["kind", "maintenance"], ["amount", "-5"], ["dueAt", "2026-10-01"]]],
    ["issueInvoice", [["clientId", C], ["kind", "gratis"], ["amount", "5"], ["dueAt", "2026-10-01"]]],
    ["issueInvoice", [["clientId", C], ["kind", "implementation"], ["amount", "5"], ["dueAt", "2026-10-01"], ["number", "INV/1"]]],
    ["voidInvoice", [["invoiceId", ID], ["reason", "x"]]],
    ["voidInvoice", [["invoiceId", ID], ["reason", "baris\nbaru"]]],
    ["markInvoicePaid", [["invoiceId", ID], ["paidAt", "2026-10-01"], ["paymentReference", ""], ["proofReference", "b"]]],
    ["markInvoicePaid", [["invoiceId", ID], ["paidAt", "2026-10-01"], ["paymentReference", "a"], ["proofReference", "b\u0000"]]],
    ["markInvoicePaid", [["invoiceId", ID], ["paidAt", "2026-10-01"], ["paymentReference", "a".repeat(121)], ["proofReference", "b"]]],
  ] as [keyof typeof billingFormSchemas, [string, string][]][])("menolak %s %j", (name, entries) => {
    expect(parseBillingForm(name, entries).success).toBe(false);
  });
  it("field berulang ditolak", () => {
    expect(parseBillingForm("goLive", [["subscriptionId", ID], ["subscriptionId", ID], ["goLiveAt", "2026-10-01"]]).success).toBe(false);
  });
});
