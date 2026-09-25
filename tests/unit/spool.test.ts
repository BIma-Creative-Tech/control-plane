import { execFileSync } from "node:child_process";
import { watch } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildJobFile, type JobFile } from "@/lib/job-contract";
import { SpoolError, readResultFile, writeJobFileAtomic } from "@/worker/spool";

// child_process HANYA di test (membuat FIFO dengan mkfifo untuk uji penolakan); kode aplikasi tidak memakainya.

let root: string;
let spool: string;
let results: string;

const job = (id: string): JobFile =>
  buildJobFile("prod", {
    id,
    type: "odoo_sso_user",
    slug: "acme-co",
    env: "prod",
    dryRun: false,
    actor: "user:abc",
    createdAt: new Date("2026-09-25T10:00:00Z"),
    args: { action: "grant", email: "a@b.co", admin: false, create_kc: true },
  });

const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "cp-spool-"));
  spool = path.join(root, "spool");
  results = path.join(root, "results");
  await mkdir(path.join(spool, "tmp"), { recursive: true });
  await mkdir(path.join(spool, "new"), { recursive: true });
  await mkdir(results);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("writeJobFileAtomic", () => {
  it("menulis new/<id>.json lengkap, tmp/ kosong, mode 0600", async () => {
    const j = job(uuid(1));
    const p = await writeJobFileAtomic(spool, j);
    expect(p).toBe(path.join(spool, "new", `${uuid(1)}.json`));
    expect(JSON.parse(await readFile(p, "utf8"))).toEqual(j);
    expect(await readdir(path.join(spool, "tmp"))).toEqual([]);
    const { statSync } = await import("node:fs");
    expect(statSync(p).mode & 0o777).toBe(0o600);
  });

  it("pengamat new/ tidak pernah melihat file parsial (200 penulisan)", async () => {
    const seen: string[] = [];
    const errors: string[] = [];
    const w = watch(path.join(spool, "new"), (_ev, name) => {
      if (!name) return;
      readFile(path.join(spool, "new", name.toString()), "utf8")
        .then((t) => {
          try {
            JSON.parse(t);
            seen.push(name.toString());
          } catch {
            errors.push(name.toString());
          }
        })
        .catch(() => undefined);
    });
    try {
      await Promise.all(Array.from({ length: 200 }, (_, i) => writeJobFileAtomic(spool, job(uuid(100 + i)))));
      await new Promise((r) => setTimeout(r, 200));
    } finally {
      w.close();
    }
    expect(errors).toEqual([]);
    expect((await readdir(path.join(spool, "new"))).length).toBe(200);
    expect(await readdir(path.join(spool, "tmp"))).toEqual([]);
  });

  it("symlink di tmp/ tidak diikuti (O_NOFOLLOW|O_EXCL) → SpoolError, target tidak tersentuh", async () => {
    const target = path.join(root, "victim");
    await writeFile(target, "orig");
    await symlink(target, path.join(spool, "tmp", `${uuid(2)}.json`));
    await expect(writeJobFileAtomic(spool, job(uuid(2)))).rejects.toBeInstanceOf(SpoolError);
    expect(await readFile(target, "utf8")).toBe("orig");
    expect(await readdir(path.join(spool, "new"))).toEqual([]);
  });

  it("dir new/ tidak ada → SpoolError, tmp dibersihkan (tidak ada file setengah jadi)", async () => {
    await rm(path.join(spool, "new"), { recursive: true });
    await expect(writeJobFileAtomic(spool, job(uuid(3)))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(path.join(spool, "tmp"))).toEqual([]);
  });

  it("job_id bukan uuid ditolak sebelum menyentuh FS (path traversal)", async () => {
    const j = { ...job(uuid(4)), job_id: "../../x" };
    await expect(writeJobFileAtomic(spool, j)).rejects.toMatchObject({ code: "EINVALID" });
  });
});

describe("readResultFile", () => {
  it("belum ada → null; ada → isi", async () => {
    expect(await readResultFile(results, uuid(5))).toBeNull();
    await writeFile(path.join(results, `${uuid(5)}.json`), '{"v":1}');
    expect(await readResultFile(results, uuid(5))).toBe('{"v":1}');
  });

  it("symlink ditolak (O_NOFOLLOW)", async () => {
    await writeFile(path.join(root, "secret"), "x");
    await symlink(path.join(root, "secret"), path.join(results, `${uuid(6)}.json`));
    await expect(readResultFile(results, uuid(6))).rejects.toBeInstanceOf(SpoolError);
  });

  it("FIFO ditolak tanpa blok", async () => {
    execFileSync("mkfifo", [path.join(results, `${uuid(7)}.json`)]);
    await expect(readResultFile(results, uuid(7))).rejects.toMatchObject({ code: "ENOTREG" });
  });

  it("file > 64 KiB ditolak", async () => {
    await writeFile(path.join(results, `${uuid(8)}.json`), "x".repeat(70_000));
    await expect(readResultFile(results, uuid(8))).rejects.toMatchObject({ code: "EFBIG" });
  });
});
