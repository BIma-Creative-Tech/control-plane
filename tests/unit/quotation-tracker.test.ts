import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { parseEnv, webEnvSchema } from "@/env";
import { PAYMENT_STATE_LABEL, SCM_KIND_LABEL, SCM_STATE_LABEL, TRACK_LABEL, scmTone, trackTone } from "@/lib/format";
import { parseOdooUrls } from "@/lib/odoo-links";
import { TRACK_STAGES, parseSpkListParams, parseTrackerParams, trackerQuery } from "@/lib/spk-params";
import { MART_SPK } from "@/server/mart-spk";

const valid = {
  NODE_ENV: "production",
  DATABASE_URL: "postgresql://control_plane:x@postgres:5432/control_plane",
  AUTH_SECRET: "a".repeat(48),
  AUTH_URL: "https://cp.bimacreative.tech",
  AUTH_KEYCLOAK_ID: "control-plane",
  AUTH_KEYCLOAK_SECRET: "s".repeat(32),
  AUTH_KEYCLOAK_ISSUER: "https://auth.bimacreative.tech/realms/platform",
};

describe("parseTrackerParams (plan infra 15)", () => {
  it("default aman: semua tahap kecuali batal", () => {
    expect(parseTrackerParams({})).toEqual({ client: undefined, q: "", track: "", sort: "date_desc", page: 1, pageSize: 50 });
  });
  it("tahap tidak dikenal → default, bukan error", () => {
    expect(parseTrackerParams({ track: "lunas'; drop" }).track).toBe("");
    for (const t of TRACK_STAGES) expect(parseTrackerParams({ track: t }).track).toBe(t);
  });
  it("trackerQuery hanya menulis parameter non-default", () => {
    const p = parseTrackerParams({ client: "expomedia", q: "pnw" });
    expect(trackerQuery(p)).toBe("?client=expomedia&q=pnw");
    expect(trackerQuery(p, { track: "ditagih", page: 2 })).toBe("?client=expomedia&q=pnw&track=ditagih&page=2");
  });
});

describe("label tahap & status bayar", () => {
  it("semua tahap punya label dan warna khusus", () => {
    for (const t of TRACK_STAGES) {
      expect(TRACK_LABEL[t]).toBeTruthy();
      expect(trackTone(t)).not.toContain("slate-100");
    }
    expect(trackTone("lain")).toContain("slate");
    expect(PAYMENT_STATE_LABEL.partial).toBe("Sebagian");
  });
});

describe("DASHBOARD_ODOO_URLS", () => {
  it("opsional dan berformat slug=https://host", () => {
    expect(parseEnv(webEnvSchema, valid).DASHBOARD_ODOO_URLS).toBeUndefined();
    const env = parseEnv(webEnvSchema, { ...valid, DASHBOARD_ODOO_URLS: "expomedia=https://erp.expomedia.id,demo=https://demo.erp.bimacreative.tech" });
    expect(parseOdooUrls(env.DASHBOARD_ODOO_URLS)).toEqual({
      expomedia: "https://erp.expomedia.id",
      demo: "https://demo.erp.bimacreative.tech",
    });
  });
  it("menolak http, path, atau karakter liar", () => {
    for (const bad of ["expomedia=http://erp.expomedia.id", "expomedia=https://erp.expomedia.id/odoo", "Expo=https://x.id", "expomedia=javascript:alert(1)"]) {
      expect(() => parseEnv(webEnvSchema, { ...valid, DASHBOARD_ODOO_URLS: bad })).toThrow(/DASHBOARD_ODOO_URLS/);
    }
  });
});

describe("label supply chain (plan infra 16)", () => {
  it("setiap jenis dokumen SCM & state utama punya label Indonesia", () => {
    for (const k of ["po", "receipt", "mo", "delivery", "bill"]) expect(SCM_KIND_LABEL[k]).toBeTruthy();
    for (const st of ["draft", "purchase", "done", "cancel", "assigned", "confirmed", "progress", "posted"]) {
      expect(SCM_STATE_LABEL[st]).toBeTruthy();
    }
  });
  it("warna status: selesai hijau, batal merah, lainnya biru/abu", () => {
    expect(scmTone("done")).toContain("emerald");
    expect(scmTone("posted")).toContain("emerald");
    expect(scmTone("cancel")).toContain("rose");
    expect(scmTone("draft")).toContain("slate");
    expect(scmTone("assigned")).toContain("blue");
  });
});

describe("penawaran dibuat vs terkirim (mart_spk.quotation_state)", () => {
  it("tahap 'terkirim' tepat setelah 'penawaran' dan punya label sendiri", () => {
    expect(TRACK_STAGES.indexOf("terkirim")).toBe(TRACK_STAGES.indexOf("penawaran") + 1);
    expect(TRACK_LABEL.penawaran).toBe("Penawaran dibuat");
    expect(TRACK_LABEL.terkirim).toBe("Penawaran terkirim");
    expect(trackTone("terkirim")).toContain("sky");
    expect(trackerQuery({}, { track: "terkirim" })).toBe("?track=terkirim");
  });
  it("filter status daftar SPK menerima dibuat/terkirim", () => {
    expect(parseSpkListParams({ status: "terkirim" }).status).toBe("terkirim");
    expect(parseSpkListParams({ status: "dibuat" }).status).toBe("dibuat");
    expect(parseSpkListParams({ status: "sent" }).status).toBe("spk");
  });
  it("sumber SQL toleran terhadap data mart lama tanpa kolom quotation_state", () => {
    expect(MART_SPK).toContain("to_jsonb(m) ->> 'quotation_state'");
    expect(MART_SPK).toContain("'dibuat'");
    expect(MART_SPK).not.toMatch(/\$\d/);
  });
});
