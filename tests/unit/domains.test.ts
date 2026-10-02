/**
 * Domains W5 (murni + Server Action langsung): checklist DNS persis per kegunaan, form `.strict()`, aturan tautan
 * environment, env PLATFORM_PUBLIC_IPV4, otorisasi (superadmin saja) sebelum layanan/DB.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

class RedirectSignal extends Error {
  constructor(readonly url: string) {
    super(`redirect:${url}`);
  }
}

const h = vi.hoisted(() => ({
  session: null as null | { user: { id: string }; roles: string[] },
  services: { createDomain: vi.fn(), updateDomain: vi.fn(), deleteDomain: vi.fn() },
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
vi.mock("@/server/context", () => ({
  assertSameOrigin: h.assertSameOrigin,
  actorFromSession: h.actorFromSession,
  requestMeta: vi.fn(async () => ({ ip: null, requestId: null })),
}));
vi.mock("@/jobs/domains", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/jobs/domains")>();
  return { ...orig, ...h.services };
});

import { createDomainAction, deleteDomainAction, updateDomainAction } from "@/app/clients/domain-actions";
import { parseEnv, webEnvSchema } from "@/env";
import * as domainService from "@/jobs/domains";
import { dnsChecklist, envLinkAllowed, parseDomainForm } from "@/lib/domains";
import { ACTION_RESULT_CODES } from "@/lib/job-list-params";
import { can } from "@/lib/roles";

const C = "11111111-1111-4111-8111-111111111111";
const D = "22222222-2222-4222-8222-222222222222";
const E = "33333333-3333-4333-8333-333333333333";
const entries = (o: Record<string, string>) => Object.entries(o) as [string, string][];
const fd = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.append(k, v);
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

describe("checklist DNS (brief Fase 1)", () => {
  it("odoo/web/insight: satu record A ke IP platform, tanpa AAAA", () => {
    for (const purpose of ["odoo", "web", "insight"] as const) {
      const c = dnsChecklist({ fqdn: "erp.acme.co.id", purpose, dkimTxt: null }, "31.97.50.221");
      expect(c.records).toEqual([{ type: "A", host: "@", name: "erp.acme.co.id", value: "31.97.50.221" }]);
      expect(c.records.some((r) => (r.type as string) === "AAAA")).toBe(false);
      expect(c.notes.join(" ")).toMatch(/AAAA/);
    }
  });
  it("IP belum dikonfigurasi → nilai null + penanda", () => {
    expect(dnsChecklist({ fqdn: "erp.acme.co.id", purpose: "odoo", dkimTxt: null }, null).records).toEqual([
      { type: "A", host: "@", name: "erp.acme.co.id", value: null, pending: "IP belum dikonfigurasi" },
    ]);
  });
  it("mail: MX 10, SPF, DKIM (atau menunggu), DMARC p=none dengan rua dmarc@<fqdn>", () => {
    const c = dnsChecklist({ fqdn: "acme.co.id", purpose: "mail", dkimTxt: null }, "31.97.50.221");
    expect(c.records).toEqual([
      { type: "MX", host: "@", name: "acme.co.id", value: "mail.bimacreative.tech.", priority: 10 },
      { type: "TXT", host: "@", name: "acme.co.id", value: '"v=spf1 include:_spf.bimacreative.tech -all"' },
      { type: "TXT", host: "mail._domainkey", name: "mail._domainkey.acme.co.id", value: null, pending: "menunggu DKIM" },
      { type: "TXT", host: "_dmarc", name: "_dmarc.acme.co.id", value: '"v=DMARC1; p=none; adkim=s; aspf=s; rua=mailto:dmarc@acme.co.id"' },
    ]);
    expect(c.notes.join(" ")).toMatch(/quarantine setelah 2 minggu/);
    const k = dnsChecklist({ fqdn: "acme.co.id", purpose: "mail", dkimTxt: "v=DKIM1; k=rsa; p=MIIBIjAN" }, null);
    expect(k.records[2]).toEqual({ type: "TXT", host: "mail._domainkey", name: "mail._domainkey.acme.co.id", value: '"v=DKIM1; k=rsa; p=MIIBIjAN"' });
  });
  it("sso / purpose kosong: tanpa record, catatan Fase berikutnya", () => {
    expect(dnsChecklist({ fqdn: "login.acme.co.id", purpose: "sso", dkimTxt: null }, "31.97.50.221").records).toEqual([]);
    expect(dnsChecklist({ fqdn: "x.acme.co.id", purpose: null, dkimTxt: null }, "31.97.50.221").records).toEqual([]);
  });
});

describe("form domain (.strict)", () => {
  it("fqdn dinormalisasi (huruf kecil, titik akhir dibuang); environmentId kosong = tanpa", () => {
    const r = parseDomainForm("createDomain", entries({ clientId: C, fqdn: " ERP.Acme.co.id. ", purpose: "odoo", environmentId: "", dkim_txt: "" }));
    expect(r).toEqual({ success: true, data: { clientId: C, fqdn: "erp.acme.co.id", purpose: "odoo", environmentId: undefined, dkim_txt: undefined } });
  });
  it("fqdn tak valid / purpose asing / DKIM berkarakter berbahaya / field asing / field berulang → ditolak", () => {
    for (const fqdn of ["localhost", "-x.acme.co.id", "a..b.co", "acme.co.1d", "xn--.co", "a_b.co.id", "x".repeat(64) + ".co", "acme.co.id/evil", "acme co.id"]) {
      expect(parseDomainForm("createDomain", entries({ clientId: C, fqdn, purpose: "odoo" })).success, fqdn).toBe(false);
    }
    expect(parseDomainForm("createDomain", entries({ clientId: C, fqdn: "acme.co.id", purpose: "ftp" })).success).toBe(false);
    for (const dkim_txt of ['v=DKIM1; p="x"', "v=DKIM1\\n", "<script>", "v=DKIM1;\u0000"]) {
      expect(parseDomainForm("createDomain", entries({ clientId: C, fqdn: "acme.co.id", purpose: "mail", dkim_txt })).success, dkim_txt).toBe(false);
    }
    expect(parseDomainForm("createDomain", entries({ clientId: C, fqdn: "acme.co.id", purpose: "mail", status: "verified" })).success).toBe(false);
    expect(parseDomainForm("updateDomain", entries({ domainId: D, purpose: "web", fqdn: "lain.co.id" })).success).toBe(false);
    expect(parseDomainForm("createDomain", [["clientId", C], ["fqdn", "a.co.id"], ["fqdn", "b.co.id"], ["purpose", "web"]]).success).toBe(false);
  });
  it("tautan environment: hanya odoo/web dan env milik tenant yang sama", () => {
    expect(envLinkAllowed("odoo", { clientId: C }, C)).toBe(true);
    expect(envLinkAllowed("web", { clientId: C }, C)).toBe(true);
    expect(envLinkAllowed("mail", { clientId: C }, C)).toBe(false);
    expect(envLinkAllowed("insight", { clientId: C }, C)).toBe(false);
    expect(envLinkAllowed("odoo", { clientId: D }, C)).toBe(false);
    expect(envLinkAllowed("mail", null, C)).toBe(true);
  });
});

describe("env PLATFORM_PUBLIC_IPV4", () => {
  const valid = {
    NODE_ENV: "production",
    DATABASE_URL: "postgresql://control_plane:x@postgres:5432/control_plane",
    AUTH_SECRET: "a".repeat(48),
    AUTH_URL: "https://cp.bimacreative.tech",
    AUTH_KEYCLOAK_ID: "control-plane",
    AUTH_KEYCLOAK_SECRET: "s".repeat(32),
    AUTH_KEYCLOAK_ISSUER: "https://auth.bimacreative.tech/realms/platform",
  };
  it("default tidak diisi; kosong = tidak diisi; IPv4 publik diterima", () => {
    expect(parseEnv(webEnvSchema, valid).PLATFORM_PUBLIC_IPV4).toBeUndefined();
    expect(parseEnv(webEnvSchema, { ...valid, PLATFORM_PUBLIC_IPV4: "" }).PLATFORM_PUBLIC_IPV4).toBeUndefined();
    expect(parseEnv(webEnvSchema, { ...valid, PLATFORM_PUBLIC_IPV4: "31.97.50.221" }).PLATFORM_PUBLIC_IPV4).toBe("31.97.50.221");
  });
  it("privat/loopback/link-local/CGNAT/IPv6/bukan IP → ditolak", () => {
    for (const ip of ["10.0.0.1", "172.20.0.5", "192.168.1.1", "127.0.0.1", "169.254.1.1", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "2a02:4780::1", "31.97.50", "abc"]) {
      expect(() => parseEnv(webEnvSchema, { ...valid, PLATFORM_PUBLIC_IPV4: ip }), ip).toThrow(/PLATFORM_PUBLIC_IPV4/);
    }
  });
});

describe("Server Action Domains dipanggil langsung", () => {
  const CALLS: [string, (f: FormData) => Promise<void>, () => FormData, keyof typeof h.services][] = [
    ["createDomainAction", createDomainAction, () => fd({ back: "acme-co", clientId: C, fqdn: "erp.acme.co.id", purpose: "odoo", environmentId: E }), "createDomain"],
    ["updateDomainAction", updateDomainAction, () => fd({ back: "acme-co", domainId: D, purpose: "mail", dkim_txt: "v=DKIM1; k=rsa; p=AB" }), "updateDomain"],
    ["deleteDomainAction", deleteDomainAction, () => fd({ back: "acme-co", domainId: D, confirm: "erp.acme.co.id" }), "deleteDomain"],
  ];
  beforeEach(() => {
    vi.clearAllMocks();
    for (const f of Object.values(h.services)) f.mockResolvedValue({ ok: true, id: D, slug: "acme-co" });
  });
  it("domains:manage = superadmin saja", () => {
    expect(can(["superadmin"], "domains:manage")).toBe(true);
    for (const r of ["ops", "client_admin", "client_user"] as const) expect(can([r], "domains:manage")).toBe(false);
  });
  it.each(CALLS)("ops / client_admin / client_user → %s ditolak (/forbidden) tanpa layanan; tanpa sesi → /login", async (_n, action, form) => {
    for (const roles of [["ops"], ["client_admin"], ["client_user"]]) {
      h.session = { user: { id: "x" }, roles };
      expect(await redirectOf(action(form()))).toBe("/forbidden");
    }
    h.session = null;
    expect(await redirectOf(action(form()))).toBe("/login");
    for (const f of Object.values(h.services)) expect(f).not.toHaveBeenCalled();
  });
  it.each(CALLS)("superadmin → %s sampai ke layanan; redirect ke halaman tenant", async (_n, action, form, svc) => {
    h.session = { user: { id: "x" }, roles: ["superadmin"] };
    expect(await redirectOf(action(form()))).toMatch(/^\/clients\/acme-co\?r=(created|updated|deleted)#domains$/);
    expect(h.services[svc]).toHaveBeenCalledTimes(1);
  });
  it("Origin asing → origin; field asing → invalid (layanan tidak dipanggil); kode hasil ter-whitelist", async () => {
    h.session = { user: { id: "x" }, roles: ["superadmin"] };
    h.assertSameOrigin.mockResolvedValueOnce(false);
    expect(await redirectOf(createDomainAction(CALLS[0]![2]()))).toBe("/clients/acme-co?r=origin#domains");
    expect(await redirectOf(createDomainAction(fd({ back: "acme-co", clientId: C, fqdn: "a.co.id", purpose: "odoo", status: "verified" })))).toBe(
      "/clients/acme-co?r=invalid#domains",
    );
    expect(await redirectOf(createDomainAction(fd({ back: "../evil", clientId: C, fqdn: "a.co.id", purpose: "x" })))).toBe("/clients?r=invalid");
    for (const f of Object.values(h.services)) expect(f).not.toHaveBeenCalled();
    for (const reason of ["forbidden", "not_found", "tenant_inactive", "exists", "env_mismatch", "confirm"] as const) {
      expect(ACTION_RESULT_CODES).toContain(domainService.domainOutcomeCode({ ok: false, reason }, "create"));
    }
  });
  it("layanan menolak ulang tanpa domains:manage (sebelum transaksi)", async () => {
    const real = await vi.importActual<typeof domainService>("@/jobs/domains");
    const db = { insert: () => ({ values: async () => undefined }), select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }) } as never;
    for (const roles of [["ops"], ["client_admin"], ["client_user"]]) {
      const input = { actor: { sub: "s", userId: null, roles: roles as never }, meta: { ip: null, requestId: null } };
      expect(await real.createDomain(db, input, { clientId: C, fqdn: "a.co.id", purpose: "odoo" })).toEqual({ ok: false, reason: "forbidden" });
      expect(await real.deleteDomain(db, input, { domainId: D, confirm: "a.co.id" })).toEqual({ ok: false, reason: "forbidden" });
    }
  });
});
