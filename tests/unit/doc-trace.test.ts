import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { issueTone, odooRecordPath, ruleLabel, sortIssues, type DocTraceIssue } from "@/lib/doc-trace";
import { MART_SPK } from "@/server/mart-spk";

const issue = (issueId: number, extra: Partial<DocTraceIssue> = {}): DocTraceIssue => ({
  issueId, ruleCode: "ZERO_BILL", severity: "warn", resModel: "account.move", resId: issueId, docNo: `BILL-${issueId}`,
  state: "open", message: null, firstSeen: null, lastSeen: new Date(2026, 9, issueId), fixedAt: null, ...extra,
});

describe("isu link dokumen (plan 18)", () => {
  it("label aturan Indonesia; kode baru → pesan Odoo, lalu kode", () => {
    expect(ruleLabel(issue(1))).toBe("Tagihan vendor Rp 0 / ganda");
    expect(ruleLabel(issue(1, { ruleCode: "RULE_BARU", message: "Pesan dari Odoo" }))).toBe("Pesan dari Odoo");
    expect(ruleLabel(issue(1, { ruleCode: "RULE_BARU" }))).toBe("RULE_BARU");
  });

  it("nada: diperbaiki otomatis = baik; terbuka mengikuti severity", () => {
    expect(issueTone(issue(1, { state: "auto_fixed", severity: "error" }))).toBe("good");
    expect(issueTone(issue(1, { severity: "error" }))).toBe("danger");
    expect(issueTone(issue(1, { severity: "warn" }))).toBe("warn");
    expect(issueTone(issue(1, { severity: "info" }))).toBe("info");
  });

  it("urutan: terbuka dulu (error → warn → info), lalu terbaru; diperbaiki otomatis di akhir", () => {
    const sorted = sortIssues([
      issue(1, { state: "auto_fixed", severity: "error" }), issue(2, { severity: "info" }), issue(3, { severity: "warn" }),
      issue(4, { severity: "error" }), issue(5, { severity: "warn" }),
    ]);
    expect(sorted.map((i) => i.issueId)).toEqual([4, 5, 3, 2, 1]);
  });

  it("path rekaman Odoo hanya untuk model & id valid", () => {
    expect(odooRecordPath("account.move", 8579)).toBe("/odoo/account.move/8579");
    expect(odooRecordPath("account.move/../x", 1)).toBeNull();
    expect(odooRecordPath("res_partner", 1)).toBeNull();
    expect(odooRecordPath("sale.order", 0)).toBeNull();
    expect(odooRecordPath("sale.order", 1.5)).toBeNull();
  });

  it("jumlah isu dibaca toleran (mart lama tanpa kolom → 0), tanpa parameter", () => {
    expect(MART_SPK).toContain("coalesce((to_jsonb(m) ->> 'issue_count')::int, 0) AS issues");
    expect(MART_SPK).not.toMatch(/\$\d/);
  });
});
