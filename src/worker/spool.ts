/**
 * I/O spool & hasil (plan 05 §3.2). Tata letak (bind mount compose, J3):
 *   <spool>/tmp/<id>.json   ditulis worker dulu (O_EXCL|O_NOFOLLOW, fsync)
 *   <spool>/new/<id>.json   rename atomik dari tmp (satu filesystem/mount) → memicu infra-job-<inst>.path
 *   <results>/<id>.json     ditulis dispatcher (root), read-only bagi worker
 * Tidak ada child_process, tidak ada path dari input user: nama file = uuid job tervalidasi.
 */
import { constants } from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { JOB_FILE_MAX_BYTES, RESULT_FILE_MAX_BYTES, UUID_REGEX, serializeJobFile, type JobFile } from "../lib/job-contract";

export class SpoolError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "SpoolError";
  }
}

function fileName(id: string): string {
  if (!UUID_REGEX.test(id)) throw new SpoolError("job_id tidak valid", "EINVALID");
  return `${id}.json`;
}

async function fsyncDir(dir: string): Promise<void> {
  const fh = await open(dir, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
}

/**
 * Tulis file job secara atomik: tmp/<id>.json (O_CREAT|O_EXCL|O_NOFOLLOW, 0600, fsync) → rename ke
 * new/<id>.json. Dispatcher tidak pernah melihat file setengah tertulis. Melempar SpoolError HANYA bila
 * rename belum terjadi (pemanggil boleh menandai gagal); fsync direktori setelah rename best-effort.
 */
export async function writeJobFileAtomic(spoolDir: string, job: JobFile): Promise<string> {
  const name = fileName(job.job_id);
  const body = serializeJobFile(job);
  if (Buffer.byteLength(body, "utf8") > JOB_FILE_MAX_BYTES) throw new SpoolError("file job > 8 KiB", "EFBIG");
  const tmpPath = path.join(spoolDir, "tmp", name);
  const newPath = path.join(spoolDir, "new", name);

  let fh;
  try {
    fh = await open(tmpPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  } catch (err) {
    throw new SpoolError("gagal membuat file tmp", (err as NodeJS.ErrnoException).code ?? "EIO");
  }
  try {
    await fh.writeFile(body, "utf8");
    await fh.sync();
  } catch (err) {
    await fh.close().catch(() => undefined);
    await unlink(tmpPath).catch(() => undefined);
    throw new SpoolError("gagal menulis file tmp", (err as NodeJS.ErrnoException).code ?? "EIO");
  }
  await fh.close();
  try {
    await rename(tmpPath, newPath);
  } catch (err) {
    await unlink(tmpPath).catch(() => undefined);
    throw new SpoolError("gagal rename ke new/", (err as NodeJS.ErrnoException).code ?? "EIO");
  }
  await fsyncDir(path.join(spoolDir, "new")).catch(() => undefined);
  return newPath;
}

/**
 * Baca results/<id>.json. `null` bila belum ada. Menolak symlink (O_NOFOLLOW), non-regular (FIFO/dir),
 * dan file > RESULT_FILE_MAX_BYTES — worker tidak pernah blok pada FIFO (O_NONBLOCK).
 */
export async function readResultFile(resultsDir: string, id: string): Promise<string | null> {
  const p = path.join(resultsDir, fileName(id));
  let fh;
  try {
    fh = await open(p, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    throw new SpoolError("gagal membuka file hasil", code ?? "EIO");
  }
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw new SpoolError("file hasil bukan file reguler", "ENOTREG");
    if (st.size > RESULT_FILE_MAX_BYTES) throw new SpoolError("file hasil terlalu besar", "EFBIG");
    const buf = Buffer.alloc(st.size);
    const { bytesRead } = await fh.read(buf, 0, st.size, 0);
    return buf.subarray(0, bytesRead).toString("utf8");
  } finally {
    await fh.close();
  }
}
