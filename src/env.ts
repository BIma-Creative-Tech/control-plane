import { z } from "zod";

/**
 * Validasi environment saat boot (instrumentation.ts untuk web, worker/index.ts untuk worker).
 * Pesan error hanya berisi NAMA variabel + alasan — nilai (secret) tidak pernah dicetak.
 * Tidak ada secret di NEXT_PUBLIC_* (lihat assertNoPublicSecrets).
 */

const postgresUrl = z
  .string()
  .regex(/^postgres(ql)?:\/\/[^\s]+$/, "harus berupa URL postgres:// atau postgresql://");

const httpUrl = z.url({ protocol: /^https?$/, message: "harus URL http(s)" });

const logLevel = z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info");

const baseEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("production"),
  DATABASE_URL: postgresUrl,
  LOG_LEVEL: logLevel,
  /**
   * Instance jembatan infra-job (plan 05, ADR 0009): `prod` (env tenant prod|demo) atau `staging`
   * (env tenant staging). Kosong = fitur job Odoo/SSO nonaktif (UI read-only, worker tidak menulis spool).
   * Satu-satunya pemilih staging/prod — tidak ada deteksi dari hostname/DB.
   */
  INFRA_JOBS_INSTANCE: z.enum(["prod", "staging"]).optional(),
});

/** Path absolut sederhana (tanpa `..`, tanpa spasi). Bind mount dari compose, bukan input user. */
const absDir = z
  .string()
  .regex(/^\/[A-Za-z0-9._/-]{1,200}$/, "harus path absolut")
  .refine((p) => !p.split("/").includes(".."), "tidak boleh memuat ..");

export const workerEnvSchema = baseEnvSchema
  .extend({
    /** Spool ditulis worker (bind mount rw /var/lib/infra-jobs/<inst>/spool): berisi tmp/ dan new/. */
    INFRA_JOBS_SPOOL_DIR: absDir.optional(),
    /** Hasil dispatcher (bind mount ro /var/lib/infra-jobs/<inst>/results). */
    INFRA_JOBS_RESULTS_DIR: absDir.optional(),
    /** Interval collector/watchdog (detik). */
    INFRA_JOBS_POLL_SECONDS: z.coerce.number().int().min(1).max(60).default(5),
    /** Toleransi antrean serial dispatcher sebelum `no_result` (detik, di atas timeout tipe job). */
    INFRA_JOBS_QUEUE_GRACE_SECONDS: z.coerce.number().int().min(60).max(86_400).default(900),
  })
  .superRefine((env, ctx) => {
    const set = [env.INFRA_JOBS_SPOOL_DIR, env.INFRA_JOBS_RESULTS_DIR, env.INFRA_JOBS_INSTANCE].filter(
      (v) => v !== undefined,
    ).length;
    if (env.INFRA_JOBS_SPOOL_DIR !== undefined || env.INFRA_JOBS_RESULTS_DIR !== undefined) {
      if (set !== 3) {
        ctx.addIssue({
          code: "custom",
          path: ["INFRA_JOBS_SPOOL_DIR"],
          message: "INFRA_JOBS_SPOOL_DIR, INFRA_JOBS_RESULTS_DIR dan INFRA_JOBS_INSTANCE wajib diisi bersama",
        });
      }
    }
    if (
      env.INFRA_JOBS_SPOOL_DIR !== undefined &&
      env.INFRA_JOBS_SPOOL_DIR.replace(/\/$/, "") === env.INFRA_JOBS_RESULTS_DIR?.replace(/\/$/, "")
    ) {
      ctx.addIssue({ code: "custom", path: ["INFRA_JOBS_RESULTS_DIR"], message: "harus berbeda dari spool" });
    }
  });

export const webEnvSchema = baseEnvSchema
  .extend({
    // Auth.js v5 membaca nama-nama ini langsung (node_modules/@auth/core/lib/utils/env.js).
    AUTH_SECRET: z.string().min(32, "minimal 32 karakter (openssl rand -base64 48)"),
    AUTH_URL: httpUrl,
    AUTH_KEYCLOAK_ID: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/, "client id tidak valid"),
    AUTH_KEYCLOAK_SECRET: z.string().min(16, "minimal 16 karakter"),
    AUTH_KEYCLOAK_ISSUER: httpUrl,
    /**
     * ADR 0016 — data mart (role datamart_reader, RLS). Opsional: kosong = dashboard SPK nonaktif.
     * DATAMART_ENV memilih baris env tenant yang dibaca (staging untuk cp.staging, prod untuk cp). Keduanya atau tidak sama sekali.
     */
    DATAMART_URL: postgresUrl.optional(),
    DATAMART_ENV: z.enum(["prod", "staging"]).optional(),
  })
  .superRefine((env, ctx) => {
    if ((env.DATAMART_URL === undefined) !== (env.DATAMART_ENV === undefined)) {
      ctx.addIssue({ code: "custom", path: ["DATAMART_URL"], message: "DATAMART_URL dan DATAMART_ENV wajib diisi bersama" });
    }
    if (env.NODE_ENV === "production") {
      for (const key of ["AUTH_URL", "AUTH_KEYCLOAK_ISSUER"] as const) {
        if (!env[key].startsWith("https://")) {
          ctx.addIssue({ code: "custom", path: [key], message: "wajib https di production" });
        }
      }
    }
    if (!/\/realms\/[^/]+$/.test(env.AUTH_KEYCLOAK_ISSUER.replace(/\/$/, ""))) {
      ctx.addIssue({
        code: "custom",
        path: ["AUTH_KEYCLOAK_ISSUER"],
        message: "harus berbentuk https://<host>/realms/<realm>",
      });
    }
  });

export type WorkerEnv = z.infer<typeof workerEnvSchema>;
export type WebEnv = z.infer<typeof webEnvSchema>;

const SECRET_LIKE = /(SECRET|PASSWORD|PASSWD|TOKEN|PRIVATE|DATABASE|_KEY$|^KEY)/i;

/** Tolak variabel NEXT_PUBLIC_* yang namanya terlihat seperti secret (di-inline ke bundle client). */
export function assertNoPublicSecrets(source: Record<string, string | undefined>): void {
  const offenders = Object.keys(source).filter(
    (k) => k.startsWith("NEXT_PUBLIC_") && SECRET_LIKE.test(k.slice("NEXT_PUBLIC_".length)),
  );
  if (offenders.length > 0) {
    throw new Error(`Env tidak valid: variabel publik terlihat seperti secret: ${offenders.join(", ")}`);
  }
}

function formatIssues(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
}

export function parseEnv<S extends z.ZodType>(schema: S, source: Record<string, string | undefined>): z.infer<S> {
  assertNoPublicSecrets(source);
  const result = schema.safeParse(source);
  if (!result.success) {
    throw new Error(`Env tidak valid: ${formatIssues(result.error)}`);
  }
  return result.data;
}

let webEnvCache: WebEnv | undefined;
let workerEnvCache: WorkerEnv | undefined;

/** Env aplikasi web (lazy + memo, agar `next build` tidak butuh secret). */
export function getWebEnv(): WebEnv {
  webEnvCache ??= parseEnv(webEnvSchema, process.env);
  return webEnvCache;
}

export function getWorkerEnv(): WorkerEnv {
  workerEnvCache ??= parseEnv(workerEnvSchema, process.env);
  return workerEnvCache;
}
