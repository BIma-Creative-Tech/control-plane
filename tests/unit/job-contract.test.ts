import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ContractError,
  JOB_FILE_MAX_BYTES,
  TAIL_MAX_BYTES,
  buildJobFile,
  checkSsoHosts,
  dbNameFor,
  defaultHost,
  dispatchDeadline,
  emailHash,
  isValidHostForEnv,
  mapFinalOutcome,
  parseResultFile,
  sanitizeResult,
  sanitizeTail,
  serializeJobFile,
  validateJobRequest,
  type Instance,
  type JobFile,
} from "@/lib/job-contract";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/infra-job/${name}`, import.meta.url), "utf8"));
const validJobs = fixture("job-valid.json") as JobFile[];
const invalidJobs = fixture("job-invalid.json") as { case: string; instance: Instance; job: unknown }[];

const instanceFor = (env: string): Instance => (env === "staging" ? "staging" : "prod");
const JOB_ID = "4b8f3c9e-4a51-4c2e-9d6a-1f2e3d4c5b6a";

describe("validateJobRequest — fixture valid (kontrak bersama dengan dispatcher J1)", () => {
  it.each(validJobs.map((j) => [j.type, j.job_id, j] as const))("%s %s lolos dan round-trip ke file job identik", (_t, _id, j) => {
    const v = validateJobRequest(instanceFor(j.env), { type: j.type, slug: j.slug, env: j.env, dryRun: j.dry_run, args: j.args });
    expect(v.ok).toBe(true);
    const built = buildJobFile(instanceFor(j.env), {
      id: j.job_id,
      type: j.type,
      slug: j.slug,
      env: j.env,
      dryRun: j.dry_run,
      actor: j.actor,
      createdAt: new Date(j.requested_at),
      args: j.args,
    });
    expect(built).toEqual(j);
    // Urutan kunci tetap sesuai contoh plan 05 §4.1.
    expect(Object.keys(built)).toEqual(["v", "job_id", "type", "slug", "env", "dry_run", "actor", "requested_at", "args"]);
  });
});

describe("validateJobRequest — matriks negatif", () => {
  it("minimal 40 kasus negatif", () => {
    expect(invalidJobs.length).toBeGreaterThanOrEqual(40);
  });
  it.each(invalidJobs.map((c) => [c.case, c] as const))("ditolak: %s", (_name, c) => {
    // Tanpa route aktif (routeHosts kosong) — aturan host SSO dicek checkSsoHosts (= check_hosts dispatcher).
    const v = validateJobRequest(c.instance, c.job);
    expect(v.ok && checkSsoHosts(v.value, []).ok).toBe(false);
  });
});

describe("regex = dispatcher infra_job.py (1bcfe0a)", () => {
  it("slug tidak diawali/diakhiri '-'", () => {
    for (const ok of ["abc", "a-b", "acme-co", "a".repeat(30), "0ab"]) expect(validateJobRequest("prod", { type: "odoo_db_provision", slug: ok, env: "prod", dryRun: false, args: {} }).ok).toBe(true);
    for (const bad of ["-ab", "ab-", "-a-", "a".repeat(31), "ab"]) expect(validateJobRequest("prod", { type: "odoo_db_provision", slug: bad, env: "prod", dryRun: false, args: {} }).ok).toBe(false);
  });
  it("email: local-part ≤ 64, tidak diawali '.'/'-', total ≤ 254", () => {
    const req = (email: string) =>
      validateJobRequest("prod", { type: "odoo_sso_user", slug: "acme-co", env: "prod", dryRun: false, args: { action: "grant", email, admin: false, create_kc: true } }).ok;
    expect(req("a.b-c_d%e+f@x.co")).toBe(true);
    expect(req("_a@x.co")).toBe(true);
    expect(req(`${"a".repeat(64)}@x.co`)).toBe(true);
    expect(req(`${"a".repeat(65)}@x.co`)).toBe(false);
    expect(req(".a@x.co")).toBe(false);
    expect(req("-a@x.co")).toBe(false);
    expect(req("a@-x.co")).toBe(false);
  });
  it("revoke dengan admin=true ditolak (v_sso_user)", () => {
    expect(validateJobRequest("prod", { type: "odoo_sso_user", slug: "acme-co", env: "prod", dryRun: false, args: { action: "revoke", email: "a@b.co", admin: true, create_kc: false } })).toEqual({ ok: false, issue: "admin_revoke" });
  });
});

describe("aturan host & turunan", () => {
  it("host per env: prod/demo *.erp, staging *.staging", () => {
    expect(isValidHostForEnv("acme.erp.bimacreative.tech", "prod")).toBe(true);
    expect(isValidHostForEnv("acme.erp.bimacreative.tech", "demo")).toBe(true);
    expect(isValidHostForEnv("acme.erp.bimacreative.tech", "staging")).toBe(false);
    expect(isValidHostForEnv("acme.staging.bimacreative.tech", "staging")).toBe(true);
    expect(isValidHostForEnv("x.acme.erp.bimacreative.tech", "prod")).toBe(false);
    expect(isValidHostForEnv("acme.erp.bimacreative.tech.evil.com", "prod")).toBe(false);
    expect(isValidHostForEnv("acme-.erp.bimacreative.tech", "prod")).toBe(false);
  });
  it("default host & nama DB sama dengan skrip", () => {
    expect(defaultHost("acme-co", "prod")).toBe("acme-co.erp.bimacreative.tech");
    expect(defaultHost("acme-co", "staging")).toBe("acme-co.staging.bimacreative.tech");
    expect(defaultHost("acme-co", "demo")).toBeNull();
    expect(dbNameFor("acme-co", "prod")).toBe("acme_co_prod");
  });
});

describe("buildJobFile (validasi ulang di worker)", () => {
  const base = {
    id: JOB_ID,
    type: "odoo_db_provision",
    slug: "acme-co",
    env: "prod" as const,
    dryRun: false,
    actor: "user:abc",
    createdAt: new Date("2026-09-25T10:00:00.123Z"),
    args: {},
  };
  it("requested_at tanpa milidetik, ≤ 8 KiB", () => {
    const f = buildJobFile("prod", base);
    expect(f.requested_at).toBe("2026-09-25T10:00:00Z");
    expect(Buffer.byteLength(serializeJobFile(f))).toBeLessThanOrEqual(JOB_FILE_MAX_BYTES);
  });
  it.each([
    ["job_id bukan uuid", { id: "../../etc/passwd" }],
    ["actor tidak valid", { actor: "user:a b" }],
    ["actor tanpa prefix", { actor: "root" }],
    ["env null", { env: null }],
    ["env lintas instance", { env: "staging" as const }],
    ["tipe lama (bukan bridge)", { type: "provision" }],
    ["baris DB diubah: args ekstra", { args: { host: "acme-co.erp.bimacreative.tech", cmd: "id" } }],
  ])("menolak %s", (_n, patch) => {
    expect(() => buildJobFile("prod", { ...base, ...patch })).toThrow(ContractError);
  });
});

describe("parseResultFile / sanitasi hasil", () => {
  const raw = readFileSync(new URL("../fixtures/infra-job/result-valid.json", import.meta.url), "utf8");

  it("RESULT ter-allowlist, secret/secret_file dibuang, tail teredaksi", () => {
    const r = parseResultFile(raw, JOB_ID);
    expect(r).not.toBeNull();
    expect(r!.result).toEqual({
      db: "acme_co_prod",
      realm: "platform",
      client: "odoo-acme-co-prod",
      provider: "7",
      hosts: "acme-co.erp.bimacreative.tech",
      changed: "3",
    });
    expect(JSON.stringify(r)).not.toContain("secrets/oidc");
    expect(r!.tail).toEqual(["[acme_co_prod] ok", "[redacted]", "RESULT db=acme_co_prod"]);
    expect(mapFinalOutcome(r!)).toEqual({ status: "succeeded", errorCode: null });
  });

  it("job_id berbeda / JSON rusak / versi lain / terlalu besar → null", () => {
    expect(parseResultFile(raw, "00000000-0000-4000-8000-000000000000")).toBeNull();
    expect(parseResultFile("{", JOB_ID)).toBeNull();
    expect(parseResultFile(JSON.stringify({ ...JSON.parse(raw), v: 2 }), JOB_ID)).toBeNull();
    expect(parseResultFile(" ".repeat(70_000), JOB_ID)).toBeNull();
  });

  it("nilai RESULT dengan karakter terlarang dibuang; angka dikonversi", () => {
    expect(sanitizeResult({ db: "a b", changed: 3, host: "x;rm", mode: "dry-run", evil: "x" })).toEqual({
      changed: "3",
      mode: "dry-run",
    });
  });

  it("tail: ≤ 40 baris, ≤ 8 KiB, karakter kontrol dibuang, non-string dibuang", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i} ${"x".repeat(400)}`);
    const t = sanitizeTail([...lines, 42, "\u001b[31mred\u0007"]);
    expect(t.length).toBeLessThanOrEqual(40);
    expect(t.reduce((n, l) => n + Buffer.byteLength(l) + 1, 0)).toBeLessThanOrEqual(TAIL_MAX_BYTES);
    expect(t.at(-1)).toBe("[31mred");
    expect(sanitizeTail(["Authorization: Bearer x", "PASSWORD=1", "ok"])).toEqual(["[redacted]", "[redacted]", "ok"]);
  });

  it("pemetaan status final (plan 05 §4.3)", () => {
    const r = parseResultFile(raw, JOB_ID)!;
    expect(mapFinalOutcome({ ...r, state: "running" })).toBeNull();
    // exit 0 tanpa RESULT = failed
    expect(mapFinalOutcome({ ...r, result: {} })).toEqual({ status: "failed", errorCode: "script_exit" });
    expect(mapFinalOutcome({ ...r, exitCode: 1 })).toEqual({ status: "failed", errorCode: "script_exit" });
    expect(mapFinalOutcome({ ...r, state: "failed", errorCode: "locked" })).toEqual({ status: "failed", errorCode: "locked" });
    expect(mapFinalOutcome({ ...r, state: "failed", errorCode: null })).toEqual({ status: "failed", errorCode: "script_exit" });
  });

  it("error_code tidak dikenal → script_exit (ditandai); state rejected → failed", () => {
    const j = { v: 1, job_id: JOB_ID, state: "rejected", exit_code: null, error_code: "weird_code", result: null, tail: [] };
    const r = parseResultFile(JSON.stringify(j), JOB_ID)!;
    expect(r.state).toBe("failed");
    expect(r.errorCode).toBe("script_exit");
    expect(r.unknownErrorCode).toBe(true);
    const q = parseResultFile(JSON.stringify({ ...j, state: "failed", error_code: "rejected_quota" }), JOB_ID)!;
    expect(mapFinalOutcome(q)).toEqual({ status: "failed", errorCode: "rejected_quota" });
  });
});

describe("util", () => {
  it("emailHash stabil, huruf kecil, tanpa email mentah", () => {
    expect(emailHash("A@B.co")).toBe(emailHash("a@b.co"));
    expect(emailHash("a@b.co")).toMatch(/^[0-9a-f]{64}$/);
  });
  it("deadline dispatch = timeout + preflight + kill + grace", () => {
    const d = dispatchDeadline("odoo_route", new Date(0), 900);
    expect(d.getTime()).toBe((60 + 60 + 30 + 900) * 1000);
  });
});
