import { describe, expect, it } from "vitest";
import { BCTONE_PACK_ARGS } from "@/lib/job-contract";
import {
  INDUSTRIES,
  INDUSTRY_LABEL,
  MODULES,
  businessSchema,
  emailDigest,
  generateOtp,
  minimumTier,
  needsReview,
  otpMatches,
  parseModules,
  selectableTiers,
  signRegCookie,
  startSchema,
  verifyRegCookie,
} from "@/lib/bctone-register";

const S = "s".repeat(40);
const ID = "3f2c7a9e-1b4d-4e8a-9c3f-5a6b7c8d9e0f";

describe("paket minimum dari modul & outlet", () => {
  it("modul gratis + 1 outlet = free; modul UMKM = umkm; bisnis = bisnis", () => {
    expect(minimumTier(["pos", "inventory"], 1)).toBe("free");
    expect(minimumTier(["pos", "restaurant"], 1)).toBe("umkm");
    expect(minimumTier(["pos", "accounting"], 1)).toBe("bisnis");
  });
  it("outlet menaikkan tier: 2 → umkm, 3..10 → bisnis, >10 → enterprise", () => {
    expect(minimumTier(["pos"], 2)).toBe("umkm");
    expect(minimumTier(["pos"], 3)).toBe("bisnis");
    expect(minimumTier(["pos"], 10)).toBe("bisnis");
    expect(minimumTier(["pos"], 11)).toBe("enterprise");
  });
  it("pilihan paket ≥ minimum, tanpa enterprise", () => {
    expect(selectableTiers("free")).toEqual(["free", "umkm", "bisnis"]);
    expect(selectableTiers("bisnis")).toEqual(["bisnis"]);
    expect(selectableTiers("enterprise")).toEqual([]);
  });
  it("review: bisnis atau kebutuhan di luar katalog", () => {
    expect(needsReview("free", null)).toBe(false);
    expect(needsReview("umkm", null)).toBe(false);
    expect(needsReview("umkm", "integrasi ojol")).toBe(true);
    expect(needsReview("bisnis", null)).toBe(true);
  });
});

describe("form", () => {
  it("akun: email dinormalisasi, slug platform & format salah ditolak, syarat wajib", () => {
    const ok = startSchema.parse({ email: " Owner@Kopi.ID ", owner_name: "Budi Santoso", business_name: " Kopi  Senja ", slug: "kopi-senja", terms: "on" });
    expect([ok.email, ok.business_name]).toEqual(["owner@kopi.id", "Kopi Senja"]);
    for (const slug of ["platform", "-kopi", "ko", "Kopi_Senja"]) {
      expect(startSchema.safeParse({ ...ok, terms: "on", slug }).success, slug).toBe(false);
    }
    expect(startSchema.safeParse({ email: "a@b.co", owner_name: "Budi", business_name: "Kopi", slug: "kopi", terms: "off" }).success).toBe(false);
    expect(startSchema.safeParse({ email: "a@b.co", owner_name: "Budi", business_name: "Kopi", slug: "kopi", terms: "on", plan: "bisnis" }).success).toBe(false);
  });
  it("bisnis: outlet 1..500", () => {
    expect(businessSchema.safeParse({ industry: "fnb", outlets: "0" }).success).toBe(false);
    expect(businessSchema.parse({ industry: "retail", outlets: "3" }).outlets).toBe(3);
    expect(businessSchema.safeParse({ industry: "logistik", outlets: "1" }).success).toBe(false);
  });
  it("modul: hanya kode katalog & sesuai industri, urutan katalog, minimal satu", () => {
    expect(parseModules({ m_inventory: "on", m_pos: "on", extra_needs: "  " }, "fnb")).toEqual({ ok: true, modules: ["pos", "inventory"], extra: null });
    expect(parseModules({ m_sales: "on" }, "fnb")).toEqual({ ok: false }); // sales khusus retail
    expect(parseModules({ m_rm_rf: "on" }, "fnb")).toEqual({ ok: false });
    expect(parseModules({ extra_needs: "x" }, "fnb")).toEqual({ ok: false });
    expect(parseModules({ m_pos: "on", extra_needs: "x".repeat(501) }, "fnb")).toEqual({ ok: false });
    expect(MODULES.every((m) => m.industries.length > 0)).toBe(true);
  });
  it("jenis usaha = pack dispatcher; tiap jenis punya label dan modul gratis", () => {
    expect(INDUSTRIES).toEqual(BCTONE_PACK_ARGS);
    for (const i of INDUSTRIES) {
      expect(INDUSTRY_LABEL[i]).toBeTruthy();
      expect(MODULES.some((m) => m.tier === "free" && m.industries.includes(i))).toBe(true);
      expect(businessSchema.parse({ industry: i, outlets: "1" }).industry).toBe(i);
    }
    expect(parseModules({ m_project: "on", m_timesheet: "on", m_invoicing: "on" }, "jasa")).toEqual({
      ok: true,
      modules: ["invoicing", "project", "timesheet"],
      extra: null,
    });
    expect(minimumTier(["invoicing", "project"], 1)).toBe("free");
    expect(minimumTier(["project", "timesheet"], 1)).toBe("umkm");
    expect(parseModules({ m_pos: "on" }, "jasa")).toEqual({ ok: false }); // POS bukan untuk jasa
    expect(parseModules({ m_repair: "on" }, "bengkel")).toEqual({ ok: true, modules: ["repair"], extra: null });
  });
});

describe("cookie & OTP", () => {
  it("cookie HMAC: palsu/diubah/secret lain ditolak", () => {
    const c = signRegCookie(S, ID);
    expect(verifyRegCookie(S, c)).toBe(ID);
    expect(verifyRegCookie("t".repeat(40), c)).toBeNull();
    expect(verifyRegCookie(S, c.replace(ID, "4f2c7a9e-1b4d-4e8a-9c3f-5a6b7c8d9e0f"))).toBeNull();
    expect(verifyRegCookie(S, `${c}.x`)).toBeNull();
    expect(verifyRegCookie(S, undefined)).toBeNull();
  });
  it("OTP 6 digit, hash bergaram, salah ditolak", () => {
    const o = generateOtp();
    expect(o.code).toMatch(/^[0-9]{6}$/);
    expect(o.hash).not.toContain(o.code);
    expect(otpMatches(o.salt, o.hash, o.code)).toBe(true);
    expect(otpMatches(o.salt, o.hash, o.code === "000000" ? "000001" : "000000")).toBe(false);
  });
  it("emailDigest tidak membocorkan email", () => {
    expect(emailDigest("A@B.co")).toBe(emailDigest("a@b.co"));
    expect(emailDigest("a@b.co")).toMatch(/^[0-9a-f]{16}$/);
  });
});
