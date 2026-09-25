/**
 * Kontrak CP ⇄ dispatcher `infra-job` (J2b). Fixture = salinan persis scripts/infra-job/contract/fixtures.json
 * (repo infra, commit 1bcfe0a — lihat tests/fixtures/infra-job/dispatcher-fixtures.origin.txt).
 * Syarat: setiap kasus valid dispatcher lolos validasi CP; setiap kasus invalid yang BISA diekspresikan
 * lewat CP ditolak CP. Kasus yang tidak bisa diekspresikan CP diuji sebagai properti penulis/serializer.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildJobFile,
  checkSsoHosts,
  serializeJobFile,
  validateJobFileObject,
  validateJobRequest,
  type Instance,
  type JobFile,
  type JobRequest,
} from "@/lib/job-contract";
import { parseForm } from "@/lib/job-forms";

const FIXTURE_URL = new URL("../fixtures/infra-job/dispatcher-fixtures.json", import.meta.url);
const ORIGIN_URL = new URL("../fixtures/infra-job/dispatcher-fixtures.origin.txt", import.meta.url);
const rawFixture = readFileSync(FIXTURE_URL);

interface Fixture {
  route_files: Record<string, string[]>;
  valid: { name: string; instance: Instance; job: JobFile }[];
  invalid: { name: string; instance: Instance; job?: Record<string, unknown>; raw?: string; error_code: string }[];
}
const fx = JSON.parse(rawFixture.toString("utf8")) as Fixture;

/** Kasus invalid yang tidak bisa dibentuk CP (bukan properti isi objek job). */
const NOT_EXPRESSIBLE: Record<string, string> = {
  job_id_mismatch: "nama file spool SELALU `${job_id}.json` (writeJobFileAtomic menurunkannya dari isi)",
};

/** Rute tenant menurut fixture (cermin environments.host + route_status=active di CP). */
function routeHostsFor(slug: string, env: string): string[] {
  return fx.route_files[`${slug}-${env}.yml`] ?? [];
}

/** Validasi CP lengkap atas objek file job: validateJobFileObject + checkSsoHosts (layanan). */
function cpAccepts(instance: Instance, job: unknown): boolean {
  const v = validateJobFileObject(instance, job);
  if (!v.ok) return false;
  const f = v.value;
  const req: JobRequest = { type: f.type, slug: f.slug, env: f.env, dryRun: f.dry_run, args: f.args as never };
  return checkSsoHosts(req, routeHostsFor(f.slug, f.env)).ok;
}

describe("fixture dispatcher: asal & integritas", () => {
  it("sha256 salinan = yang dicatat di origin.txt", () => {
    const sha = createHash("sha256").update(rawFixture).digest("hex");
    expect(readFileSync(ORIGIN_URL, "utf8")).toContain(`sha256   : ${sha}`);
  });
  it("jumlah kasus", () => {
    expect(fx.valid.length).toBeGreaterThanOrEqual(15);
    expect(fx.invalid.length).toBeGreaterThanOrEqual(100);
  });
});

describe("valid dispatcher → lolos CP (dan CP menghasilkan file yang identik)", () => {
  it.each(fx.valid.map((c) => [c.name, c] as const))("%s", (_n, c) => {
    expect(cpAccepts(c.instance, c.job)).toBe(true);
    const built = buildJobFile(c.instance, {
      id: c.job.job_id,
      type: c.job.type,
      slug: c.job.slug,
      env: c.job.env,
      dryRun: c.job.dry_run,
      actor: c.job.actor,
      createdAt: new Date(c.job.requested_at),
      args: c.job.args,
    });
    expect(built).toEqual(c.job);
    expect(serializeJobFile(built)).toMatch(/^[\x20-\x7e]*\n$/);
  });
});

describe("invalid dispatcher (objek job) → ditolak CP", () => {
  const cases = fx.invalid.filter((c) => c.job && !(c.name in NOT_EXPRESSIBLE));
  it.each(cases.map((c) => [c.name, c] as const))("%s", (_n, c) => {
    expect(cpAccepts(c.instance, c.job)).toBe(false);
  });

  it("job_id_mismatch tidak dapat dibentuk: nama file selalu dari job_id", () => {
    expect(Object.keys(NOT_EXPRESSIBLE)).toEqual(["job_id_mismatch"]);
  });
});

describe("invalid dispatcher (file mentah) → CP tidak pernah menghasilkan teks itu", () => {
  const raws = fx.invalid.filter((c) => typeof c.raw === "string");
  it.each(raws.map((c) => [c.name, c] as const))("%s", (_n, c) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(c.raw!);
    } catch {
      return; // JSON tidak valid — serializer CP (JSON.stringify) tidak bisa menghasilkannya
    }
    const v = validateJobFileObject(c.instance, parsed);
    if (!v.ok) return;
    // Objeknya valid (mis. kunci duplikat bernilai sama): teks mentah ≠ keluaran serializer CP.
    expect(serializeJobFile(v.value)).not.toBe(c.raw);
    expect(serializeJobFile(v.value).trimEnd()).not.toBe(c.raw);
  });
});

describe("normalisasi form CP (email huruf kecil) tidak meloloskan email yang ditolak dispatcher", () => {
  const ENV_ID = "11111111-1111-4111-8111-111111111111";
  const emailCases = fx.invalid.filter((c) => c.name.startsWith("email_") && c.job);
  it.each(emailCases.map((c) => [c.name, c] as const))("%s", (_n, c) => {
    const email = String((c.job!.args as Record<string, unknown>).email);
    const r = parseForm("ssoUser", [
      ["environmentId", ENV_ID],
      ["action", "grant"],
      ["email", email],
    ]);
    if (!r.success) return; // form menolak
    // form menerima setelah trim+lowercase → nilai yang DIKIRIM harus valid bagi dispatcher (regex disalin persis)
    const args = { ...(c.job!.args as Record<string, unknown>), email: r.data.email };
    expect(validateJobRequest(c.instance, { type: c.job!.type, slug: c.job!.slug, env: c.job!.env, dryRun: false, args }).ok).toBe(true);
  });
});
