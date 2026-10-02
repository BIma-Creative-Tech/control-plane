/**
 * ADR 0018 D4/D5/D8 — logika murni siklus langganan: aritmetika tanggal WIB (akhir bulan, kabisat), tabel transisi
 * (semua status × kondisi), pembayaran, Go-live, pengingat, nomor invoice, TICK_NOW hanya staging, komposisi email.
 */
import { describe, expect, it } from "vitest";
import {
  INVOICE_NUMBER_REGEX,
  SUBSCRIPTION_STATUSES,
  addDays,
  addMonths,
  adminCheckKey,
  composeAdminReport,
  composeReminder,
  dateToTimestamp,
  daysBetween,
  dueReminder,
  formatAmount,
  formatInvoiceNumber,
  invoicePrefix,
  isIsoDate,
  jakartaDate,
  nextInvoiceSeq,
  oneLine,
  planGoLive,
  planPayment,
  planTransitions,
  reminderKey,
  tenantsWithoutAdmin,
  tickToday,
  timestampToDate,
  type SubscriptionSnapshot,
  type SubscriptionStatus,
} from "@/lib/billing";

const snap = (o: Partial<SubscriptionSnapshot>): SubscriptionSnapshot => ({
  status: "implementation",
  warrantyUntil: null,
  startsAt: null,
  endsAt: null,
  graceUntil: null,
  periodMonths: 1,
  ...o,
});

describe("tanggal WIB", () => {
  it.each([
    ["2026-01-31", 1, "2026-02-28"],
    ["2028-01-31", 1, "2028-02-29"],
    ["2028-02-29", 12, "2029-02-28"],
    ["2026-03-31", 1, "2026-04-30"],
    ["2026-08-31", 1, "2026-09-30"],
    ["2026-12-31", 1, "2027-01-31"],
    ["2026-11-30", 2, "2027-01-30"],
    ["2026-12-15", 2, "2027-02-15"],
    ["2026-10-03", 2, "2026-12-03"],
    ["2026-12-31", 2, "2027-02-28"],
    ["2026-03-31", -1, "2026-02-28"],
    ["2026-01-15", 0, "2026-01-15"],
    ["2026-05-31", 24, "2028-05-31"],
  ])("addMonths(%s, %i) = %s", (d, n, want) => {
    expect(addMonths(d, n)).toBe(want);
  });

  it("periode berantai dari akhir bulan mengikuti hasil klem (tanpa celah: ends lama = starts baru)", () => {
    let d = "2026-01-31";
    const seq: string[] = [];
    for (let i = 0; i < 4; i++) {
      d = addMonths(d, 1);
      seq.push(d);
    }
    expect(seq).toEqual(["2026-02-28", "2026-03-28", "2026-04-28", "2026-05-28"]);
  });

  it("addDays lintas bulan/tahun/kabisat; daysBetween", () => {
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDays("2026-12-03", -14)).toBe("2026-11-19");
    expect(daysBetween("2026-12-03", "2027-01-17")).toBe(45);
    expect(daysBetween("2027-01-17", "2026-12-03")).toBe(-45);
  });

  it("isIsoDate menolak tanggal tidak nyata / format lain", () => {
    for (const ok of ["2026-02-28", "2028-02-29", "2026-12-31"]) expect(isIsoDate(ok)).toBe(true);
    for (const bad of ["2026-02-29", "2026-02-30", "2026-13-01", "2026-00-10", "2026-1-01", "26-01-01", "2026-01-01T00:00", "", null, 20260101, "1999-12-31"]) {
      expect(isIsoDate(bad)).toBe(false);
    }
    expect(() => addMonths("2026-02-30", 1)).toThrow();
    expect(() => addMonths("2026-01-01", 1.5)).toThrow();
  });

  it("jakartaDate = UTC+7 (pergantian hari 17:00Z); dateToTimestamp/timestampToDate bolak-balik", () => {
    expect(jakartaDate(new Date("2026-10-02T16:59:59Z"))).toBe("2026-10-02");
    expect(jakartaDate(new Date("2026-10-02T17:00:00Z"))).toBe("2026-10-03");
    expect(dateToTimestamp("2026-10-03").toISOString()).toBe("2026-10-02T17:00:00.000Z");
    expect(timestampToDate(dateToTimestamp("2028-02-29"))).toBe("2028-02-29");
    expect(timestampToDate(null)).toBeNull();
  });
});

describe("TICK_NOW hanya staging (ADR 0018 D5)", () => {
  const now = new Date("2026-10-03T03:00:00Z");
  it("staging + TICK_NOW valid → disuntik", () => {
    expect(tickToday({ INFRA_JOBS_INSTANCE: "staging", TICK_NOW: "2027-03-01" }, now)).toEqual({ today: "2027-03-01", injected: true, ignored: false });
  });
  it("prod / tanpa instance → diabaikan (tanggal nyata)", () => {
    expect(tickToday({ INFRA_JOBS_INSTANCE: "prod", TICK_NOW: "2027-03-01" }, now)).toEqual({ today: "2026-10-03", injected: false, ignored: true });
    expect(tickToday({ TICK_NOW: "2027-03-01" }, now)).toEqual({ today: "2026-10-03", injected: false, ignored: true });
  });
  it("tanpa TICK_NOW / TICK_NOW tidak valid", () => {
    expect(tickToday({ INFRA_JOBS_INSTANCE: "staging" }, now)).toEqual({ today: "2026-10-03", injected: false, ignored: false });
    expect(tickToday({ INFRA_JOBS_INSTANCE: "staging", TICK_NOW: "2027-02-30" }, now).ignored).toBe(true);
  });
});

describe("planTransitions — tabel ADR 0018 D4", () => {
  it("implementation tidak pernah berubah otomatis (berapa pun tanggalnya)", () => {
    for (const today of ["2026-10-03", "2030-01-01", "2199-12-31"]) {
      const p = planTransitions(snap({ status: "implementation" }), today);
      expect(p.transitions).toEqual([]);
      expect(p.anomaly).toBeNull();
    }
  });

  it("warranty: tetap sampai HARI warranty_until (inklusif), lalu active + invoice periode pertama", () => {
    const s = snap({ status: "warranty", warrantyUntil: "2026-12-03" });
    expect(planTransitions(s, "2026-12-02").transitions).toEqual([]);
    expect(planTransitions(s, "2026-12-03").transitions).toEqual([]);
    const p = planTransitions(s, "2026-12-04");
    expect(p.transitions).toEqual([
      { from: "warranty", to: "active", startsAt: "2026-12-03", endsAt: "2027-01-03", invoicePeriod: { start: "2026-12-03", end: "2027-01-03" } },
    ]);
    expect(p.final).toMatchObject({ status: "active", startsAt: "2026-12-03", endsAt: "2027-01-03", graceUntil: null });
  });

  it("warranty berakhir 31 Des, periode 1 bulan → ends 31 Jan; periode 3 bulan → 31 Mar", () => {
    expect(planTransitions(snap({ status: "warranty", warrantyUntil: "2026-12-31" }), "2027-01-01").final.endsAt).toBe("2027-01-31");
    expect(planTransitions(snap({ status: "warranty", warrantyUntil: "2026-12-31", periodMonths: 3 }), "2027-01-01").final.endsAt).toBe("2027-03-31");
  });

  it("active → past_due hanya bila today > ends; grace = ends + 2 bulan (klem akhir bulan)", () => {
    const s = snap({ status: "active", startsAt: "2026-11-30", endsAt: "2026-12-31" });
    expect(planTransitions(s, "2026-12-31").transitions).toEqual([]);
    expect(planTransitions(s, "2027-01-01").transitions).toEqual([{ from: "active", to: "past_due", graceUntil: "2027-02-28" }]);
  });

  it("past_due → suspended hanya bila today > grace_until (+ enqueue tenant_suspend)", () => {
    const s = snap({ status: "past_due", startsAt: "2026-11-30", endsAt: "2026-12-31", graceUntil: "2027-02-28" });
    expect(planTransitions(s, "2027-02-28").transitions).toEqual([]);
    expect(planTransitions(s, "2027-03-01").transitions).toEqual([{ from: "past_due", to: "suspended", enqueueSuspend: true }]);
  });

  it("tick terlambat jauh (worker mati / TICK_NOW) → urutan transisi lengkap dalam satu kali jalan", () => {
    const p = planTransitions(snap({ status: "warranty", warrantyUntil: "2026-12-03" }), "2027-06-01");
    expect(p.transitions.map((t) => `${t.from}>${t.to}`)).toEqual(["warranty>active", "active>past_due", "past_due>suspended"]);
    expect(p.final).toMatchObject({ status: "suspended", startsAt: "2026-12-03", endsAt: "2027-01-03", graceUntil: "2027-03-03" });
    // sebagian: berhenti di past_due bila grace belum lewat
    const q = planTransitions(snap({ status: "warranty", warrantyUntil: "2026-12-03" }), "2027-02-01");
    expect(q.transitions.map((t) => t.to)).toEqual(["active", "past_due"]);
    expect(q.final.status).toBe("past_due");
  });

  it("suspended / terminated: tidak ada transisi otomatis (resume hanya lewat pembayaran)", () => {
    for (const status of ["suspended", "terminated"] as const) {
      const p = planTransitions(snap({ status, endsAt: "2026-01-01", graceUntil: "2026-03-01" }), "2030-01-01");
      expect(p.transitions).toEqual([]);
      expect(p.anomaly).toBeNull();
    }
  });

  it("status usang pending/grace → anomali, tanpa transisi", () => {
    for (const status of ["pending", "grace"] as const) {
      expect(planTransitions(snap({ status, endsAt: "2026-01-01" }), "2030-01-01")).toMatchObject({ transitions: [], anomaly: "deprecated_status" });
    }
  });

  it("data tidak lengkap → anomali, tidak menebak", () => {
    expect(planTransitions(snap({ status: "warranty" }), "2030-01-01").anomaly).toBe("warranty_without_until");
    expect(planTransitions(snap({ status: "active" }), "2030-01-01").anomaly).toBe("active_without_period");
    expect(planTransitions(snap({ status: "past_due", endsAt: "2026-01-01" }), "2030-01-01").anomaly).toBe("past_due_without_grace");
    expect(planTransitions(snap({ status: "active", endsAt: "2026-01-01", periodMonths: 0 }), "2030-01-01").anomaly).toBe("invalid_period");
  });

  it("cakupan: setiap status enum punya perilaku terdefinisi (tidak melempar)", () => {
    for (const status of SUBSCRIPTION_STATUSES) {
      expect(() =>
        planTransitions(snap({ status, warrantyUntil: "2026-01-01", startsAt: "2026-01-01", endsAt: "2026-02-01", graceUntil: "2026-04-01" }), "2027-01-01"),
      ).not.toThrow();
    }
  });

  it("hanya warranty/active/past_due yang bisa bergerak otomatis; tidak pernah menuju suspended dari implementation/warranty langsung", () => {
    const movers = new Set<SubscriptionStatus>();
    for (const status of SUBSCRIPTION_STATUSES) {
      const p = planTransitions(snap({ status, warrantyUntil: "2026-01-01", startsAt: "2026-01-01", endsAt: "2026-02-01", graceUntil: "2026-04-01" }), "2027-01-01");
      if (p.transitions.length > 0) movers.add(status);
      for (const t of p.transitions) if (t.to === "suspended") expect(t.from).toBe("past_due");
    }
    expect([...movers].sort()).toEqual(["active", "past_due", "warranty"]);
  });
});

describe("Go-live & pembayaran", () => {
  it("Go-live hanya dari implementation; garansi = +2 bulan; tanggal masa depan ditolak", () => {
    expect(planGoLive({ status: "implementation" }, "2026-10-03", "2026-10-03")).toEqual({ ok: true, warrantyUntil: "2026-12-03" });
    expect(planGoLive({ status: "implementation" }, "2026-12-31", "2027-01-05")).toEqual({ ok: true, warrantyUntil: "2027-02-28" });
    expect(planGoLive({ status: "implementation" }, "2026-10-04", "2026-10-03")).toEqual({ ok: false, reason: "future_date" });
    for (const status of SUBSCRIPTION_STATUSES.filter((s) => s !== "implementation")) {
      expect(planGoLive({ status }, "2026-10-03", "2026-10-03")).toEqual({ ok: false, reason: "billing_status" });
    }
  });

  it("maintenance lunas: past_due/suspended/active → active, ends + satu periode, resume hanya dari suspended", () => {
    expect(planPayment({ status: "past_due", endsAt: "2027-01-03", periodMonths: 1 }, "maintenance")).toEqual({
      kind: "extend",
      from: "past_due",
      startsAt: "2027-01-03",
      endsAt: "2027-02-03",
      resume: false,
      nextInvoicePeriod: { start: "2027-01-03", end: "2027-02-03" },
    });
    expect(planPayment({ status: "suspended", endsAt: "2027-01-31", periodMonths: 1 }, "maintenance")).toMatchObject({
      kind: "extend",
      resume: true,
      endsAt: "2027-02-28",
    });
    expect(planPayment({ status: "active", endsAt: "2027-01-31", periodMonths: 12 }, "maintenance")).toMatchObject({ endsAt: "2028-01-31", resume: false });
  });

  it("implementasi / tanpa subscription / status tanpa periode → catat lunas saja", () => {
    expect(planPayment({ status: "suspended", endsAt: "2027-01-31", periodMonths: 1 }, "implementation")).toEqual({ kind: "record_only" });
    expect(planPayment(null, "maintenance")).toEqual({ kind: "record_only" });
    for (const status of ["implementation", "warranty", "terminated", "pending", "grace"] as const) {
      expect(planPayment({ status, endsAt: "2027-01-31", periodMonths: 1 }, "maintenance")).toEqual({ kind: "record_only" });
    }
    expect(planPayment({ status: "active", endsAt: null, periodMonths: 1 }, "maintenance")).toEqual({ kind: "record_only" });
  });
});

describe("pengingat (H-14 garansi; H+0/H+14/H+45 setelah ends_at)", () => {
  const w = snap({ status: "warranty", warrantyUntil: "2026-12-03" });
  it("garansi: jendela [warranty_until-14, warranty_until]", () => {
    expect(dueReminder(w, "2026-11-18")).toBeNull();
    expect(dueReminder(w, "2026-11-19")).toEqual({ kind: "warranty_h14", period: "2026-12-03" });
    expect(dueReminder(w, "2026-12-03")).toEqual({ kind: "warranty_h14", period: "2026-12-03" });
    expect(dueReminder(w, "2026-12-04")).toBeNull();
  });

  it("jatuh tempo: hanya jenis terbaru yang sudah lewat", () => {
    const a = snap({ status: "active", startsAt: "2026-12-03", endsAt: "2027-01-03" });
    expect(dueReminder(a, "2027-01-02")).toBeNull();
    expect(dueReminder(a, "2027-01-03")).toEqual({ kind: "due_h0", period: "2027-01-03" });
    const p = { ...a, status: "past_due" as const, graceUntil: "2027-03-03" };
    expect(dueReminder(p, "2027-01-16")).toEqual({ kind: "due_h0", period: "2027-01-03" });
    expect(dueReminder(p, "2027-01-17")).toEqual({ kind: "due_h14", period: "2027-01-03" });
    expect(dueReminder(p, "2027-02-16")).toEqual({ kind: "due_h14", period: "2027-01-03" });
    expect(dueReminder(p, "2027-02-17")).toEqual({ kind: "due_h45", period: "2027-01-03" });
    expect(dueReminder({ ...p, status: "suspended" }, "2027-04-01")).toEqual({ kind: "due_h45", period: "2027-01-03" });
  });

  it("status lain → tidak ada pengingat", () => {
    for (const status of ["implementation", "terminated", "pending", "grace"] as const) {
      expect(dueReminder(snap({ status, warrantyUntil: "2026-12-03", endsAt: "2026-12-03" }), "2026-12-03")).toBeNull();
    }
  });

  it("kunci idempotensi lolos regex notification_log", () => {
    const k = reminderKey("8d6c7a1e-1111-4222-8333-444455556666", { kind: "due_h14", period: "2027-01-03" });
    expect(k).toBe("reminder:8d6c7a1e-1111-4222-8333-444455556666:due_h14:2027-01-03");
    expect(k).toMatch(/^[a-z0-9_:./-]{3,200}$/);
    expect(adminCheckKey("2026-10-03")).toMatch(/^[a-z0-9_:./-]{3,200}$/);
  });
});

describe("nomor invoice INV/YYYY/MM/NNNN", () => {
  it("format + urutan per bulan", () => {
    expect(invoicePrefix("2026-10-03")).toBe("INV/2026/10/");
    expect(formatInvoiceNumber("2026-10-03", 1)).toBe("INV/2026/10/0001");
    expect(formatInvoiceNumber("2026-01-31", 12345)).toBe("INV/2026/01/12345");
    expect(INVOICE_NUMBER_REGEX.test("INV/2026/10/0001")).toBe(true);
    expect(() => formatInvoiceNumber("2026-10-03", 0)).toThrow();
    expect(() => formatInvoiceNumber("2026-10-03", 1_000_000)).toThrow();
  });
  it("nextInvoiceSeq mengabaikan bulan lain / nomor asing", () => {
    const p = "INV/2026/10/";
    expect(nextInvoiceSeq([], p)).toBe(1);
    expect(nextInvoiceSeq(["INV/2026/10/0001", "INV/2026/10/0007", "INV/2026/09/0099", "X/2026/10/0500", "INV/2026/10/abc"], p)).toBe(8);
  });
});

describe("email & laporan", () => {
  const ctx = {
    tenantName: "Acme\r\nBcc: evil@example.com",
    slug: "acme-co",
    planName: "Odoo Shared S",
    status: "past_due" as const,
    invoice: { number: "INV/2027/01/0003", amount: "1500000.00", currency: "IDR" },
    graceUntil: "2027-03-03",
    billingEmail: "billing@bimacreative.tech",
  };
  it("subject satu baris (tanpa CR/LF), isi memuat invoice & grace", () => {
    const m = composeReminder({ kind: "due_h14", period: "2027-01-03" }, ctx);
    expect(m.subject).not.toMatch(/[\r\n]/);
    expect(m.subject).toContain("2027-01-03");
    expect(m.text).toContain("INV/2027/01/0003");
    expect(m.text).toContain("IDR 1.500.000");
    expect(m.text).toContain("2027-03-03");
    expect(composeReminder({ kind: "due_h45", period: "2027-01-03" }, ctx).subject).toMatch(/^Peringatan akhir/);
    expect(composeReminder({ kind: "warranty_h14", period: "2026-12-03" }, ctx).subject).toBe("Masa garansi Acme Bcc: evil@example.com (Odoo Shared S) berakhir 2026-12-03");
    expect(composeReminder({ kind: "due_h0", period: "2027-01-03" }, { ...ctx, invoice: null }).text).toContain("akan dikirim terpisah");
  });
  it("oneLine membuang karakter kontrol; formatAmount", () => {
    expect(oneLine("a\u0000b\tc\n d")).toBe("a b c d");
    expect(formatAmount("1500000.00")).toBe("IDR 1.500.000");
    expect(formatAmount("1234.5")).toBe("IDR 1.234,50");
    expect(formatAmount(null)).toBe("—");
  });
  it("laporan tenant-admin + daftar tenant tanpa admin (platform/terminated dikecualikan)", () => {
    const t = (id: string, o: Partial<{ isPlatform: boolean; status: string; terminatedAt: Date | null }> = {}) => ({
      id,
      slug: `t-${id}`,
      isPlatform: false,
      status: "active",
      terminatedAt: null,
      ...o,
    });
    const missing = tenantsWithoutAdmin(
      [t("1"), t("2"), t("3", { isPlatform: true }), t("4", { status: "terminated" }), t("5", { terminatedAt: new Date() }), t("6", { status: "suspended" })],
      new Set(["2"]),
    );
    expect(missing.map((m) => m.id)).toEqual(["1", "6"]);
    const r = composeAdminReport("2026-10-03", ["t-1", "t-6"]);
    expect(r.subject).toContain("2 tenant");
    expect(r.text).toContain("- t-6");
  });
});
