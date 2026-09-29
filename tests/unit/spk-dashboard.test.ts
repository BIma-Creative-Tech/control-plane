import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { parseEnv, webEnvSchema } from "@/env";
import { rupiah, stageTone, tanggal } from "@/lib/format";
import { parseSpkListParams, spkQuery } from "@/lib/spk-params";

const valid = {
  NODE_ENV: "production",
  DATABASE_URL: "postgresql://control_plane:x@postgres:5432/control_plane",
  AUTH_SECRET: "a".repeat(48),
  AUTH_URL: "https://cp.bimacreative.tech",
  AUTH_KEYCLOAK_ID: "control-plane",
  AUTH_KEYCLOAK_SECRET: "s".repeat(32),
  AUTH_KEYCLOAK_ISSUER: "https://auth.bimacreative.tech/realms/platform",
};

describe("env data mart (ADR 0016)", () => {
  it("opsional: tanpa DATAMART_* valid", () => {
    expect(parseEnv(webEnvSchema, valid).DATAMART_URL).toBeUndefined();
  });
  it("DATAMART_URL dan DATAMART_ENV wajib berpasangan", () => {
    expect(() => parseEnv(webEnvSchema, { ...valid, DATAMART_URL: "postgresql://datamart_reader:x@postgres/datamart" })).toThrow(/DATAMART_URL/);
    expect(() => parseEnv(webEnvSchema, { ...valid, DATAMART_ENV: "staging" })).toThrow(/DATAMART_URL/);
    const env = parseEnv(webEnvSchema, { ...valid, DATAMART_URL: "postgresql://datamart_reader:x@postgres/datamart", DATAMART_ENV: "staging" });
    expect(env.DATAMART_ENV).toBe("staging");
  });
  it("DATAMART_ENV hanya prod|staging", () => {
    expect(() => parseEnv(webEnvSchema, { ...valid, DATAMART_URL: "postgresql://a@b/c", DATAMART_ENV: "demo" })).toThrow(/DATAMART_ENV/);
  });
});

describe("parseSpkListParams", () => {
  it("default aman", () => {
    expect(parseSpkListParams({})).toEqual({ client: undefined, q: "", stage: "", status: "spk", sort: "date_desc", page: 1, pageSize: 50 });
  });
  it("nilai tidak valid → default, bukan error", () => {
    const p = parseSpkListParams({ client: "Expo'; DROP", sort: "value; drop", status: "x", page: "-3", q: "a\u0000b" });
    expect(p.client).toBeUndefined();
    expect(p.sort).toBe("date_desc");
    expect(p.status).toBe("spk");
    expect(p.page).toBe(1);
    expect(p.q).toBe("");
  });
  it("menerima parameter valid & memotong spasi", () => {
    const p = parseSpkListParams({ client: "expomedia", q: "  POLA ", stage: "Laporan", status: "", sort: "value_desc", page: "2" });
    expect(p).toMatchObject({ client: "expomedia", q: "POLA", stage: "Laporan", status: "", sort: "value_desc", page: 2 });
  });
  it("q maksimal 60 karakter", () => {
    expect(parseSpkListParams({ q: "x".repeat(61) }).q).toBe("");
  });
  it("spkQuery hanya menulis parameter non-default", () => {
    const p = parseSpkListParams({ client: "expomedia", q: "pola" });
    expect(spkQuery(p)).toBe("?client=expomedia&q=pola");
    expect(spkQuery(p, { page: 3, stage: "BAST" })).toBe("?client=expomedia&q=pola&stage=BAST&page=3");
    expect(spkQuery(p, { status: "" })).toBe("?client=expomedia&q=pola&status=");
  });
});

describe("format", () => {
  it("rupiah & tanggal WIB", () => {
    expect(rupiah(1500000)).toMatch(/Rp\s?1\.500\.000/);
    expect(tanggal("2026-01-31T18:00:00Z")).toMatch(/01 Feb 2026/);
    expect(tanggal(null)).toBe("-");
  });
  it("tone tahap dikenal & default", () => {
    expect(stageTone("BAST")).toContain("emerald");
    expect(stageTone("Lain")).toContain("slate");
  });
});
