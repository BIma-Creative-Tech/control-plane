/**
 * Kontrak job control plane → dispatcher root `infra-job` (plan 05 §4, ADR 0009).
 * Modul murni (tanpa Next/DB) — dipakai Server Action (validasi form), worker (tulis spool, baca hasil)
 * dan unit test. Regex = regex skrip (`scripts/lib/odoo-pools.sh`, `scripts/odoo-sso-user.sh`) atau
 * LEBIH KETAT; dispatcher memvalidasi ulang (pertahanan berlapis). Tidak ada path, perintah, env var,
 * atau nama DB di file job — nama DB selalu diturunkan skrip dari slug+env.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { SLUG_REGEX } from "./slug";

// ---------------------------------------------------------------------------
// Konstanta kontrak
// ---------------------------------------------------------------------------
export const JOB_FILE_VERSION = 1 as const;
/** Batas ukuran file job di dispatcher (plan 05 §3.2). */
export const JOB_FILE_MAX_BYTES = 8 * 1024;
/** Batas baca file hasil di worker (hasil ≤ 8 KiB tail + RESULT; longgar tapi terbatas). */
export const RESULT_FILE_MAX_BYTES = 64 * 1024;

/** 5 tipe plan 05 = default allowlist dispatcher per instance bila `job_types` tidak ada di conf (kontrak Fase 1 §0.5). */
export const LEGACY_JOB_TYPES = [
  "odoo_db_provision",
  "odoo_route",
  "odoo_sso_provision",
  "odoo_sso_disable",
  "odoo_sso_user",
] as const;

/** Tipe SaaS Fase 1 (kontrak `docs/plans/saas-phase-1-contract.md` §1, repo infra). */
export const SAAS_P1_JOB_TYPES = [
  "kc_realm_sync",
  "kc_org_ensure",
  "kc_user_ensure",
  "kc_user_set_roles",
  "kc_user_set_enabled",
  "kc_user_action_email",
  "odoo_user_ensure",
  "odoo_tenant_config",
  "tenant_suspend",
  "tenant_resume",
] as const;

export const BRIDGE_JOB_TYPES = [...LEGACY_JOB_TYPES, ...SAAS_P1_JOB_TYPES] as const;
export type BridgeJobType = (typeof BRIDGE_JOB_TYPES)[number];
export type SaasP1JobType = (typeof SAAS_P1_JOB_TYPES)[number];

export function isBridgeJobType(v: unknown): v is BridgeJobType {
  return typeof v === "string" && (BRIDGE_JOB_TYPES as readonly string[]).includes(v);
}

export function isSaasP1JobType(v: unknown): v is SaasP1JobType {
  return typeof v === "string" && (SAAS_P1_JOB_TYPES as readonly string[]).includes(v);
}

/**
 * Allowlist tipe per instance (env `INFRA_JOBS_TYPES`, cermin `job_types` conf dispatcher). Kosong/tidak ada →
 * 5 tipe lama. Nama tidak dikenal dibuang (fail-closed: tipe itu tidak bisa di-enqueue).
 */
export function instanceJobTypes(raw: string | undefined): readonly BridgeJobType[] {
  if (!raw) return LEGACY_JOB_TYPES;
  const set = new Set(raw.split(",").map((t) => t.trim()));
  return BRIDGE_JOB_TYPES.filter((t) => set.has(t));
}

export const INSTANCES = ["prod", "staging"] as const;
export type Instance = (typeof INSTANCES)[number];
export type TenantEnv = "prod" | "demo" | "staging";

/** Binding instance → env (plan 05 §4.1): prod-inst → {prod, demo}; staging-inst → {staging}. */
export const INSTANCE_ENVS: Record<Instance, readonly TenantEnv[]> = {
  prod: ["prod", "demo"],
  staging: ["staging"],
};

export function envAllowedForInstance(instance: Instance, env: TenantEnv): boolean {
  return INSTANCE_ENVS[instance].includes(env);
}

/** error_code yang boleh DITULIS dispatcher ke results/ (plan 05 §4.3). */
export const DISPATCHER_ERROR_CODES = [
  "rejected_validation",
  "rejected_quota",
  "disabled",
  "blocked_dry_run",
  "locked",
  "timeout_state_unknown",
  "script_exit",
] as const;
/**
 * Semua error_code di provision_jobs: + `no_result` (watchdog CP) + `spool_error` (CP gagal menulis spool,
 * keputusan Lead J2b) + `result_inconsistent` (RESULT tidak cocok dengan aksi yang diminta, BUG-J5-01).
 * Sama dengan CHECK `provision_jobs_error_code_valid`.
 */
export const ERROR_CODES = [
  ...DISPATCHER_ERROR_CODES,
  "no_result",
  "spool_error",
  "result_inconsistent",
  // Kontrak Fase 1 §2.1: job sebelumnya di rantai (after_job_id) failed/cancelled → job ini cancelled.
  "chain_aborted",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

function isDispatcherErrorCode(v: unknown): v is (typeof DISPATCHER_ERROR_CODES)[number] {
  return typeof v === "string" && (DISPATCHER_ERROR_CODES as readonly string[]).includes(v);
}

export function isErrorCode(v: unknown): v is ErrorCode {
  return typeof v === "string" && (ERROR_CODES as readonly string[]).includes(v);
}

/**
 * Timeout dispatcher per tipe (detik, plan 05 §4.4 — estimasi, diukur ulang di J4). CP hanya memakai
 * angka ini untuk deadline watchdog `no_result`; yang menghentikan skrip adalah dispatcher.
 */
export const JOB_TIMEOUT_SECONDS: Record<BridgeJobType, number> = {
  odoo_db_provision: 900,
  odoo_route: 60,
  odoo_sso_provision: 300,
  odoo_sso_disable: 120,
  odoo_sso_user: 180,
  // Kontrak Fase 1 §1 (= DEFAULT_TIMEOUTS dispatcher).
  kc_realm_sync: 300,
  kc_org_ensure: 120,
  kc_user_ensure: 120,
  kc_user_set_roles: 120,
  kc_user_set_enabled: 120,
  kc_user_action_email: 120,
  odoo_user_ensure: 300,
  odoo_tenant_config: 300,
  tenant_suspend: 60,
  tenant_resume: 60,
};
/** Dry-run otomatis dispatcher sebelum apply (sso_provision/sso_disable/sso_user grant). */
export const DRY_RUN_PREFLIGHT_SECONDS = 60;
/** SIGTERM → SIGKILL. */
export const KILL_GRACE_SECONDS = 30;

// ---------------------------------------------------------------------------
// Regex (sama/lebih ketat dari skrip)
// ---------------------------------------------------------------------------
export { SLUG_REGEX };
// Disalin persis dari dispatcher `scripts/infra-job/infra_job.py` (repo infra, branch feat/infra-job-dispatcher,
// commit 1bcfe0a). Python `re.fullmatch(..., re.ASCII)` ≙ JS `^…$` tanpa flag m/u (JS `$` tidak cocok sebelum "\n").
/** `_LABEL` dispatcher: label DNS huruf kecil, tidak diawali/diakhiri '-'. */
const LABEL = "[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?";
/** EMAIL_RE: local-part ≤ 64, tidak diawali '.'/'-', huruf kecil saja; total ≤ 254 dicek terpisah. */
export const EMAIL_REGEX = new RegExp(`^[a-z0-9_%+][a-z0-9._%+-]{0,63}@(${LABEL}\\.)+[a-z]{2,63}$`);
export const EMAIL_MAX = 254;
/** LOGIN_RE: tidak diawali '-' (≤ 254). */
export const LOGIN_REGEX = /^[A-Za-z0-9._@+][A-Za-z0-9._@+-]{0,253}$/;
export const LOGIN_MAX = 254;
/** HOST_RE (iterasi 1, Q3: hanya subdomain platform). */
export const HOST_REGEX_PROD = new RegExp(`^${LABEL}\\.erp\\.bimacreative\\.tech$`);
export const HOST_REGEX_STAGING = new RegExp(`^${LABEL}\\.staging\\.bimacreative\\.tech$`);
/** FQDN generik skrip (`scripts/lib/odoo-pools.sh` FQDN_RE). */
export const FQDN_REGEX = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
/** ACTOR_RE (total ≤ 140). */
export const ACTOR_REGEX = /^(user|system):[A-Za-z0-9._@:-]{1,128}$/;
export const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/**
 * NAME_RE dispatcher (kontrak Fase 1 §1, varian ASCII — varian `À-ɏ` di dokumen kontrak digantikan keputusan Lead):
 * 1–100, tidak diawali spasi/'-'. Nama non-ASCII ditolak (bukan ditransliterasi) — lihat asciiName().
 */
export const NAME_REGEX = /^[A-Za-z0-9.,'][A-Za-z0-9 .,'-]{0,99}$/;
export const NAME_MAX = 100;
/** REQUESTED_AT_RE + harus tanggal valid (dispatcher: datetime.fromisoformat). */
export const REQUESTED_AT_REGEX = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/;

export function isValidRequestedAt(v: string): boolean {
  if (!REQUESTED_AT_REGEX.test(v)) return false;
  const t = Date.parse(v);
  // Tolak tanggal yang "digulung" JS (mis. 02-30 → 03-02) — Python fromisoformat menolaknya.
  return !Number.isNaN(t) && isoSeconds(new Date(t)) === v;
}

export function hostRegexForEnv(env: TenantEnv): RegExp {
  return env === "staging" ? HOST_REGEX_STAGING : HOST_REGEX_PROD;
}

export function isValidHostForEnv(host: string, env: TenantEnv): boolean {
  return host.length <= 253 && hostRegexForEnv(env).test(host) && FQDN_REGEX.test(host);
}

/** Host default skrip (`default_host`): prod `<slug>.erp…`, staging `<slug>.staging…`; demo tidak punya default. */
export function defaultHost(slug: string, env: TenantEnv): string | null {
  if (env === "prod") return `${slug}.erp.bimacreative.tech`;
  if (env === "staging") return `${slug}.staging.bimacreative.tech`;
  return null;
}

/**
 * Host route environment: kolom `environments.host` (fakta RESULT / deklarasi pendaftaran tenant lama); bila kosong,
 * hostname `environments.url`. URL tidak terbaca → null.
 */
export function envRouteHost(e: { host: string | null; url: string }): string | null {
  if (e.host) return e.host;
  try {
    const h = new URL(e.url).hostname;
    return h || null;
  } catch {
    return null;
  }
}

/**
 * Route dikelola MANUAL (M8 migrasi prod, "Daftarkan tenant yang sudah ada"): host environment di luar regex HOST
 * platform env-nya (mis. host kustom `erp.expomedia.id`). DITURUNKAN dari regex HOST — tanpa kolom/migrasi. Host tidak
 * bisa ditentukan sama sekali → dianggap manual (fail-closed: job route/SSO tidak dikirim untuk environment yang
 * host-nya tidak jelas). Adopsi route ke platform = Fase 2.
 */
export function routeManagedManually(e: { kind: TenantEnv; host: string | null; url: string }): boolean {
  const h = envRouteHost(e);
  return h === null || !isValidHostForEnv(h, e.kind);
}

/**
 * Tipe job yang menulis/memakai route & host platform environment — DITOLAK di lapisan layanan untuk environment route
 * manual (enqueueBridgeJob + rantai): tanpa host, skrip memakai host default `<slug>.<erp|staging>…` dan akan menimpa
 * route manual; dengan host kustom, regex HOST dispatcher menolaknya. DB environment adopsi sudah ada (provision ulang
 * tidak relevan).
 */
export const MANUAL_ROUTE_BLOCKED_TYPES: readonly BridgeJobType[] = ["odoo_db_provision", "odoo_route", "odoo_sso_provision", "odoo_sso_disable"];

export function blockedForManualRoute(type: string): boolean {
  return (MANUAL_ROUTE_BLOCKED_TYPES as readonly string[]).includes(type);
}

/** Nama DB turunan (sama dengan `validate_slug_env`): '-' → '_' + `_<env>`. */
export function dbNameFor(slug: string, env: TenantEnv): string {
  return `${slug.replace(/-/g, "_")}_${env}`;
}

// ---------------------------------------------------------------------------
// Skema args per tipe (additionalProperties=false → .strict())
// ---------------------------------------------------------------------------
const hostSchema = z.string().max(253).regex(FQDN_REGEX, "host tidak valid");
const emailSchema = z.string().max(EMAIL_MAX).regex(EMAIL_REGEX, "email tidak valid");
const loginSchema = z.string().max(LOGIN_MAX).regex(LOGIN_REGEX, "login tidak valid");
const nameSchema = z.string().max(NAME_MAX).regex(NAME_REGEX, "nama tidak valid");
const tenantIdSchema = z.string().max(36).regex(UUID_REGEX, "tenant_id tidak valid");

/** Tenant internal (kontrak Fase 1 §0.1): slug reserved, CP menolak membuat client bernama ini lewat form. */
export const PLATFORM_SLUG = "platform";
/** Nilai `cp_role` (kontrak §1): `none` = cabut semua role client `control-plane`. */
export const CP_ROLE_ARGS = ["none", "superadmin", "ops", "client_admin", "client_user"] as const;
export type CpRoleArg = (typeof CP_ROLE_ARGS)[number];
/** Aturan §0.3 "tidak pernah memberi hak lebih": role platform hanya di slug platform, role tenant hanya di tenant. */
export const CP_ROLES_PLATFORM = ["none", "superadmin", "ops"] as const satisfies readonly CpRoleArg[];
export const CP_ROLES_TENANT = ["none", "client_admin", "client_user"] as const satisfies readonly CpRoleArg[];
export const ODOO_ACCESS = ["none", "user", "admin"] as const;
export type OdooAccess = (typeof ODOO_ACCESS)[number];
export const ODOO_USER_ROLES = ["user", "admin"] as const;
export const KC_EMAIL_ACTIONS = ["UPDATE_PASSWORD", "VERIFY_EMAIL", "CONFIGURE_TOTP"] as const;
export const TENANT_CHECK_MODES = ["off", "compat", "strict"] as const;
/** kc_realm_sync apply di env ini wajib `approve=true`. */
export const APPROVE_ENVS: readonly TenantEnv[] = ["prod", "demo"];

export function cpRolesForSlug(slug: string): readonly CpRoleArg[] {
  return slug === PLATFORM_SLUG ? CP_ROLES_PLATFORM : CP_ROLES_TENANT;
}

/**
 * Nama untuk args job (keputusan Lead Fase 1: TOLAK non-ASCII, tidak ditransliterasi — file job ASCII saja):
 * spasi dirapikan; tidak lolos NAME_REGEX (= NAME_RE dispatcher) → null (form menampilkan pesan jelas).
 */
export function asciiName(raw: string): string | null {
  const v = raw.replace(/\s+/g, " ").trim();
  return v.length > 0 && v.length <= NAME_MAX && NAME_REGEX.test(v) ? v : null;
}

export const argsSchemas = {
  odoo_db_provision: z.object({ host: hostSchema.optional() }).strict(),
  odoo_route: z.object({ host: hostSchema.optional(), remove: z.boolean() }).strict(),
  odoo_sso_provision: z
    .object({
      hosts: z.array(hostSchema).min(1).max(5),
      rotate_secret: z.boolean(),
      skip_smoke: z.boolean(),
    })
    .strict(),
  odoo_sso_disable: z.object({ hosts: z.array(hostSchema).min(1).max(5) }).strict(),
  odoo_sso_user: z
    .object({
      action: z.enum(["grant", "revoke", "resend_invite"]),
      email: emailSchema,
      login: loginSchema.optional(),
      admin: z.boolean(),
      create_kc: z.boolean(),
    })
    .strict(),
  // --- Kontrak Fase 1 §1 (additionalProperties=false; boolean wajib JSON true|false). ---
  kc_realm_sync: z.object({ approve: z.boolean().optional() }).strict(),
  kc_org_ensure: z.object({ tenant_id: tenantIdSchema }).strict(),
  // Kontrak v1.2 (temuan QA F1): `adopt` opsional (default false) — ikat user lama (tanpa tenant_id) ke tenant job.
  // Hanya superadmin (`users:manage`) yang boleh mengirim adopt=true; ditegakkan enqueueChain + worker.
  kc_user_ensure: z
    .object({
      email: emailSchema,
      tenant_id: tenantIdSchema,
      invite: z.boolean(),
      name: nameSchema.optional(),
      adopt: z.boolean().optional(),
    })
    .strict(),
  kc_user_set_roles: z
    .object({ email: emailSchema, cp_role: z.enum(CP_ROLE_ARGS), odoo: z.enum(ODOO_ACCESS).optional() })
    .strict(),
  kc_user_set_enabled: z.object({ email: emailSchema, enabled: z.boolean() }).strict(),
  kc_user_action_email: z.object({ email: emailSchema, action: z.enum(KC_EMAIL_ACTIONS) }).strict(),
  odoo_user_ensure: z
    .object({
      email: emailSchema,
      role: z.enum(ODOO_USER_ROLES),
      active: z.boolean(),
      login: loginSchema.optional(),
      name: nameSchema.optional(),
    })
    .strict(),
  odoo_tenant_config: z.object({ tenant_check: z.enum(TENANT_CHECK_MODES) }).strict(),
  tenant_suspend: z.object({}).strict(),
  tenant_resume: z.object({}).strict(),
} as const satisfies Record<BridgeJobType, z.ZodType>;

export type JobArgs = { [K in BridgeJobType]: z.infer<(typeof argsSchemas)[K]> };

export interface JobRequest<T extends BridgeJobType = BridgeJobType> {
  type: T;
  slug: string;
  env: TenantEnv;
  dryRun: boolean;
  args: JobArgs[T];
}

export type ContractIssue =
  | "type"
  | "slug"
  | "env_instance"
  | "args"
  | "host_env"
  | "host_required"
  | "host_duplicate"
  | "host_with_remove"
  | "skip_smoke_host"
  | "dry_run_unsupported"
  | "create_kc_non_grant"
  | "admin_revoke"
  | "host_not_in_route"
  | "file_keys"
  | "version"
  | "job_id"
  | "actor"
  | "requested_at"
  | "dry_run"
  | "non_ascii"
  // Kontrak Fase 1 §1/§0.3
  | "platform_only"
  | "platform_forbidden"
  | "cp_role_slug"
  | "odoo_platform"
  | "approve_required"
  | "type_not_allowed";

export type ContractResult<T> = { ok: true; value: T } | { ok: false; issue: ContractIssue };

/**
 * Validasi penuh satu permintaan job untuk instance tertentu: tipe allowlist, slug, binding
 * instance→env, skema args, aturan host per env (plan 05 §4.2), aturan dry-run.
 * Aturan "host SSO harus ada di file route root-owned" hanya bisa dicek dispatcher (CP tidak membaca
 * file host) — CP menambah pemeriksaan setara dari DB (environments.host) di lapisan layanan.
 */
export function validateJobRequest(instance: Instance, input: unknown): ContractResult<JobRequest> {
  const base = z
    .object({
      type: z.string(),
      slug: z.string(),
      env: z.enum(["prod", "demo", "staging"]),
      dryRun: z.boolean(),
      args: z.unknown(),
    })
    .strict()
    .safeParse(input);
  if (!base.success) return { ok: false, issue: "args" };
  const { type, slug, env, dryRun, args } = base.data;
  if (!isBridgeJobType(type)) return { ok: false, issue: "type" };
  if (!SLUG_REGEX.test(slug)) return { ok: false, issue: "slug" };
  if (!envAllowedForInstance(instance, env)) return { ok: false, issue: "env_instance" };

  const parsed = argsSchemas[type].safeParse(args);
  if (!parsed.success) return { ok: false, issue: "args" };
  const a = parsed.data as Record<string, unknown>;

  const checkHost = (h: string) => isValidHostForEnv(h, env);

  switch (type) {
    case "odoo_db_provision": {
      if (dryRun) return { ok: false, issue: "dry_run_unsupported" };
      const host = a.host as string | undefined;
      if (env === "demo" && !host) return { ok: false, issue: "host_required" };
      if (host && !checkHost(host)) return { ok: false, issue: "host_env" };
      break;
    }
    case "odoo_route": {
      if (dryRun) return { ok: false, issue: "dry_run_unsupported" };
      const host = a.host as string | undefined;
      if (a.remove === true) {
        if (host) return { ok: false, issue: "host_with_remove" };
      } else {
        if (env === "demo" && !host) return { ok: false, issue: "host_required" };
        if (host && !checkHost(host)) return { ok: false, issue: "host_env" };
      }
      break;
    }
    case "odoo_sso_provision":
    case "odoo_sso_disable": {
      const hosts = a.hosts as string[];
      if (new Set(hosts).size !== hosts.length) return { ok: false, issue: "host_duplicate" };
      if (!hosts.every(checkHost)) return { ok: false, issue: "host_env" };
      // Aturan host ⊆ route (+ host default bila skip_smoke) butuh data route → checkSsoHosts().
      break;
    }
    case "odoo_sso_user": {
      // = v_sso_user dispatcher: revoke tanpa admin/create_kc; resend_invite tanpa create_kc.
      if (a.action !== "grant" && a.create_kc === true) return { ok: false, issue: "create_kc_non_grant" };
      if (a.action === "revoke" && a.admin === true) return { ok: false, issue: "admin_revoke" };
      break;
    }
    // --- Kontrak Fase 1 §1 (= v_kc_* / v_odoo_* / v_tenant_state dispatcher). ---
    case "kc_realm_sync":
      if (slug !== PLATFORM_SLUG) return { ok: false, issue: "platform_only" };
      if (APPROVE_ENVS.includes(env) && !dryRun && a.approve !== true) return { ok: false, issue: "approve_required" };
      break;
    case "kc_org_ensure":
    case "kc_user_ensure":
    case "kc_user_set_enabled":
    case "kc_user_action_email":
      // slug tenant maupun platform boleh (§1); lintas tenant ditegakkan skrip (atribut tenant_id user/alias org).
      break;
    case "kc_user_set_roles":
      // §0.3: tidak pernah memberi hak lebih — role platform hanya di slug platform, role tenant hanya di tenant.
      if (!cpRolesForSlug(slug).includes(a.cp_role as CpRoleArg)) return { ok: false, issue: "cp_role_slug" };
      if (a.odoo !== undefined && slug === PLATFORM_SLUG) return { ok: false, issue: "odoo_platform" };
      break;
    case "odoo_user_ensure":
    case "odoo_tenant_config":
    case "tenant_suspend":
    case "tenant_resume":
      if (slug === PLATFORM_SLUG) return { ok: false, issue: "platform_forbidden" };
      break;
  }
  return { ok: true, value: { type, slug, env, dryRun, args: parsed.data } as JobRequest };
}

/**
 * = check_hosts dispatcher: untuk odoo_sso_*, setiap host harus ada di route tenant; pengecualian
 * skip_smoke=true (hanya odoo_sso_provision) untuk host default `<slug>.<erp|staging>.bimacreative.tech`.
 * CP memakai `environments.host` (route aktif) sebagai cermin file route root-owned; dispatcher tetap
 * memeriksa file aslinya.
 */
export function checkSsoHosts(req: JobRequest, routeHosts: readonly string[]): ContractResult<true> {
  if (req.type !== "odoo_sso_provision" && req.type !== "odoo_sso_disable") return { ok: true, value: true };
  const a = req.args as { hosts: string[]; skip_smoke?: boolean };
  const dflt = defaultHost(req.slug, req.env);
  for (const h of a.hosts) {
    if (routeHosts.includes(h)) continue;
    if (req.type === "odoo_sso_provision" && a.skip_smoke === true && h === dflt) continue;
    return { ok: false, issue: a.skip_smoke === true ? "skip_smoke_host" : "host_not_in_route" };
  }
  return { ok: true, value: true };
}

// ---------------------------------------------------------------------------
// File job (worker → dispatcher)
// ---------------------------------------------------------------------------
export interface JobFile {
  v: typeof JOB_FILE_VERSION;
  job_id: string;
  type: BridgeJobType;
  slug: string;
  env: TenantEnv;
  dry_run: boolean;
  actor: string;
  requested_at: string;
  args: Record<string, unknown>;
}

/** ISO-8601 UTC tanpa milidetik: `2026-09-25T10:00:00Z` (contoh plan 05 §4.1). */
export function isoSeconds(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Bangun isi file job dari baris provision_jobs. Validasi ULANG (baris DB bisa diubah penyerang
 * yang punya akses DB) — gagal → lempar, worker menandai `rejected_validation` tanpa menulis spool.
 */
export function buildJobFile(
  instance: Instance,
  row: {
    id: string;
    type: string;
    slug: string;
    env: TenantEnv | null;
    dryRun: boolean;
    actor: string;
    createdAt: Date;
    args: unknown;
  },
): JobFile {
  if (!UUID_REGEX.test(row.id)) throw new ContractError("job_id");
  if (!ACTOR_REGEX.test(row.actor)) throw new ContractError("actor");
  if (!row.env) throw new ContractError("env");
  const v = validateJobRequest(instance, {
    type: row.type,
    slug: row.slug,
    env: row.env,
    dryRun: row.dryRun,
    args: row.args,
  });
  if (!v.ok) throw new ContractError(v.issue);
  const file: JobFile = {
    v: JOB_FILE_VERSION,
    job_id: row.id,
    type: v.value.type,
    slug: v.value.slug,
    env: v.value.env,
    dry_run: v.value.dryRun,
    actor: row.actor,
    requested_at: isoSeconds(row.createdAt),
    args: v.value.args as Record<string, unknown>,
  };
  const final = validateJobFileObject(instance, file);
  if (!final.ok) throw new ContractError(final.issue);
  if (Buffer.byteLength(serializeJobFile(file), "utf8") > JOB_FILE_MAX_BYTES) throw new ContractError("size");
  return file;
}

const JOB_FILE_KEYS = ["v", "job_id", "type", "slug", "env", "dry_run", "actor", "requested_at", "args"] as const;

/**
 * Validasi objek file job UTUH dengan aturan `validate_job` dispatcher (kunci top-level persis, v integer 1,
 * job_id uuid, dry_run boolean, actor ≤ 140, requested_at tanggal valid, lalu args per tipe). Dipakai
 * buildJobFile sebagai penjaga terakhir sebelum spool, dan oleh test fixture kontrak dispatcher.
 */
export function validateJobFileObject(instance: Instance, obj: unknown): ContractResult<JobFile> {
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return { ok: false, issue: "file_keys" };
  const o = obj as Record<string, unknown>;
  const keys = Object.keys(o);
  if (keys.length !== JOB_FILE_KEYS.length || !JOB_FILE_KEYS.every((k) => Object.prototype.hasOwnProperty.call(o, k))) {
    return { ok: false, issue: "file_keys" };
  }
  if (o.v !== 1) return { ok: false, issue: "version" };
  if (typeof o.job_id !== "string" || !UUID_REGEX.test(o.job_id)) return { ok: false, issue: "job_id" };
  if (typeof o.dry_run !== "boolean") return { ok: false, issue: "dry_run" };
  if (typeof o.actor !== "string" || o.actor.length > 140 || !ACTOR_REGEX.test(o.actor)) return { ok: false, issue: "actor" };
  if (typeof o.requested_at !== "string" || !isValidRequestedAt(o.requested_at)) return { ok: false, issue: "requested_at" };
  if (typeof o.slug !== "string" || o.slug.length > 30) return { ok: false, issue: "slug" };
  if (typeof o.type !== "string") return { ok: false, issue: "type" };
  if (typeof o.env !== "string" || !["prod", "demo", "staging"].includes(o.env)) return { ok: false, issue: "env_instance" };
  if (typeof o.args !== "object" || o.args === null || Array.isArray(o.args)) return { ok: false, issue: "args" };
  const v = validateJobRequest(instance, { type: o.type, slug: o.slug, env: o.env, dryRun: o.dry_run, args: o.args });
  if (!v.ok) return v;
  return { ok: true, value: o as unknown as JobFile };
}

/** JSON satu baris; dispatcher menolak non-ASCII (raw_non_ascii_utf8) — semua nilai sudah ASCII lewat regex. */
export function serializeJobFile(file: JobFile): string {
  const text = `${JSON.stringify(file)}\n`;
  if (!/^[\x00-\x7f]*$/.test(text)) throw new ContractError("non_ascii");
  return text;
}

export class ContractError extends Error {
  constructor(readonly issue: string) {
    super(`kontrak job ditolak: ${issue}`);
    this.name = "ContractError";
  }
}

// ---------------------------------------------------------------------------
// File hasil (dispatcher → worker)
// ---------------------------------------------------------------------------
/** Kunci RESULT yang boleh masuk CP (plan 05 §4.5). `secret`/`secret_file` selalu dibuang. */
export const RESULT_KEYS = [
  "db",
  "realm",
  "client",
  "provider",
  "hosts",
  "changed",
  "kc_user",
  "odoo_user",
  "action",
  "mode",
  "blockers",
  "route",
  "host",
  "created",
  "pool",
  // OBS-J5-01: fakta undangan ter-allowlist (mis. `invite=sent`) — pengganti baris tail yang teredaksi;
  // redaksi tail TIDAK dilonggarkan.
  "invite",
  // Kontrak Fase 1 §1.2 (RESULT_KEYS dispatcher += org roles enabled state tenant).
  "org",
  "roles",
  "enabled",
  "state",
  "tenant",
] as const;
const RESULT_KEY_SET: ReadonlySet<string> = new Set(RESULT_KEYS);
export const RESULT_VALUE_REGEX = /^[A-Za-z0-9._,:@/=-]{0,512}$/;
export const TAIL_MAX_LINES = 40;
export const TAIL_MAX_BYTES = 8 * 1024;
export const TAIL_LINE_MAX_CHARS = 512;
const REDACT_REGEX = /(secret|token|password|passwd|bearer|authorization)/i;

export const RESULT_STATES = ["running", "succeeded", "failed"] as const;
export type ResultState = (typeof RESULT_STATES)[number];

export interface ParsedResult {
  jobId: string;
  state: ResultState;
  exitCode: number | null;
  errorCode: ErrorCode | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  durationMs: number | null;
  result: Record<string, string>;
  tail: string[];
  /** Kode error_code dari file tidak dikenal (dicatat, dipetakan ke `script_exit`). */
  unknownErrorCode: boolean;
}

const isoDate = z
  .string()
  .max(40)
  .refine((s) => !Number.isNaN(Date.parse(s)))
  .transform((s) => new Date(s));

/**
 * Pembaca toleran untuk kunci tambahan (dispatcher boleh menambah metadata), ketat untuk tipe/nilai
 * kunci yang dipakai. `state` "rejected" (bila J1 memakainya) diperlakukan sebagai `failed`.
 */
const resultFileSchema = z.object({
  v: z.literal(1),
  job_id: z.string().regex(UUID_REGEX),
  state: z.enum(["running", "succeeded", "failed", "rejected"]),
  exit_code: z.number().int().min(-255).max(255).nullable().optional(),
  error_code: z.string().max(64).nullable().optional(),
  started_at: isoDate.nullable().optional(),
  finished_at: isoDate.nullable().optional(),
  duration_ms: z.number().int().min(0).max(86_400_000).nullable().optional(),
  result: z.record(z.string(), z.unknown()).nullable().optional(),
  tail: z.array(z.unknown()).nullable().optional(),
});

/** Filter RESULT: allowlist kunci + regex nilai; kunci secret* dibuang. */
export function sanitizeResult(raw: Record<string, unknown> | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  for (const [k, v] of Object.entries(raw)) {
    if (!RESULT_KEY_SET.has(k)) continue;
    const value = typeof v === "number" && Number.isFinite(v) ? String(v) : v;
    if (typeof value !== "string" || !RESULT_VALUE_REGEX.test(value)) continue;
    out[k] = value;
  }
  return out;
}

/** Redaksi tail: ≤ 40 baris terakhir, ≤ 8 KiB, baris mirip secret → `[redacted]`, kontrol dibuang. */
export function sanitizeTail(raw: readonly unknown[] | null | undefined): string[] {
  if (!raw) return [];
  const lines = raw
    .filter((l): l is string => typeof l === "string")
    .map((l) =>
      l.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").slice(0, TAIL_LINE_MAX_CHARS),
    )
    .map((l) => (REDACT_REGEX.test(l) ? "[redacted]" : l))
    .slice(-TAIL_MAX_LINES);
  // Pangkas dari depan sampai ≤ 8 KiB.
  let total = lines.reduce((n, l) => n + Buffer.byteLength(l, "utf8") + 1, 0);
  while (lines.length > 0 && total > TAIL_MAX_BYTES) {
    total -= Buffer.byteLength(lines.shift() as string, "utf8") + 1;
  }
  return lines;
}

/** Parse isi file hasil. `null` = tidak valid / bukan untuk job ini (dicatat pemanggil). */
export function parseResultFile(text: string, expectedJobId: string): ParsedResult | null {
  if (Buffer.byteLength(text, "utf8") > RESULT_FILE_MAX_BYTES) return null;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const p = resultFileSchema.safeParse(json);
  if (!p.success || p.data.job_id !== expectedJobId) return null;
  const d = p.data;
  const rawCode = d.error_code ?? null;
  // Hanya kode dispatcher yang dipercaya dari file hasil (no_result/spool_error = milik CP).
  const known = isDispatcherErrorCode(rawCode);
  return {
    jobId: d.job_id,
    state: d.state === "rejected" ? "failed" : d.state,
    exitCode: d.exit_code ?? null,
    errorCode: rawCode === null ? null : known ? rawCode : "script_exit",
    startedAt: d.started_at ?? null,
    finishedAt: d.finished_at ?? null,
    durationMs: d.duration_ms ?? null,
    result: sanitizeResult(d.result),
    tail: sanitizeTail(d.tail),
    unknownErrorCode: rawCode !== null && !known,
  };
}

export interface FinalOutcome {
  status: "succeeded" | "failed";
  errorCode: ErrorCode | null;
}

/**
 * Pemetaan hasil final → status CP (plan 05 §4.3): `succeeded` hanya bila state=succeeded, exit 0
 * DAN RESULT terbaca (≥ 1 kunci). Selain itu `failed` dengan error_code dari dispatcher, atau
 * `script_exit` bila tidak ada.
 */
export function mapFinalOutcome(r: ParsedResult): FinalOutcome | null {
  if (r.state === "running") return null;
  if (r.state === "succeeded") {
    if (r.exitCode === 0 && Object.keys(r.result).length > 0) return { status: "succeeded", errorCode: null };
    return { status: "failed", errorCode: "script_exit" };
  }
  return { status: "failed", errorCode: r.errorCode ?? "script_exit" };
}

/**
 * Fakta undangan dari RESULT `invite=` (OBS-J5-01). Hanya nilai yang dikenal ditampilkan sebagai teks; nilai
 * lain → "unknown" (nilai mentah tetap terlihat di tabel RESULT, sudah lolos RESULT_VALUE_REGEX).
 */
export const INVITE_FACTS = { sent: "Undangan (execute-actions-email) terkirim", none: "Tidak ada undangan dikirim" } as const;
export type InviteFact = keyof typeof INVITE_FACTS | "unknown";

export function inviteFact(result: Record<string, string> | null | undefined): InviteFact | null {
  const v = result?.invite;
  if (v === undefined) return null;
  return v === "sent" || v === "none" ? v : "unknown";
}

/** Hash email untuk audit_logs.metadata (PII tidak masuk audit, plan 05 §5.1). */
export function emailHash(email: string): string {
  return createHash("sha256").update(email.trim().toLowerCase(), "utf8").digest("hex");
}

/**
 * idempotency_key (kontrak Fase 1 §2.2) = `<type>:<slug>:<env>:<target>`; target = email untuk tipe user,
 * `org` untuk kc_org_ensure, `realm` untuk kc_realm_sync, `tenant` untuk odoo_tenant_config/tenant_*. Tipe lama
 * (plan 05) dan job dry-run → null (tidak di-dedupe; tipe lama memakai provision_jobs_one_active_uq).
 */
export function idempotencyKey(req: Pick<JobRequest, "type" | "slug" | "env" | "dryRun" | "args">): string | null {
  if (req.dryRun || !isSaasP1JobType(req.type)) return null;
  const a = req.args as Record<string, unknown>;
  let target: string;
  switch (req.type) {
    case "kc_realm_sync":
      target = "realm";
      break;
    case "kc_org_ensure":
      target = "org";
      break;
    case "odoo_tenant_config":
    case "tenant_suspend":
    case "tenant_resume":
      target = "tenant";
      break;
    default:
      if (typeof a.email !== "string") return null;
      target = a.email;
  }
  return `${req.type}:${req.slug}:${req.env}:${target}`;
}

/** Env realm untuk job identitas (kc_*) per instance: prod-inst → `prod` (realm platform), staging → `staging`. */
export function realmEnvForInstance(instance: Instance): TenantEnv {
  return instance === "staging" ? "staging" : "prod";
}

/** Deadline watchdog setelah dispatch: timeout + preflight + kill + antrean serial dispatcher. */
export function dispatchDeadline(type: BridgeJobType, from: Date, queueGraceSeconds: number): Date {
  const s = JOB_TIMEOUT_SECONDS[type] + DRY_RUN_PREFLIGHT_SECONDS + KILL_GRACE_SECONDS + queueGraceSeconds;
  return new Date(from.getTime() + s * 1000);
}

/** Deadline setelah dispatcher melaporkan `running` (antrean sudah lewat). */
export function runningDeadline(type: BridgeJobType, startedAt: Date): Date {
  const s = JOB_TIMEOUT_SECONDS[type] + DRY_RUN_PREFLIGHT_SECONDS + KILL_GRACE_SECONDS + 120;
  return new Date(startedAt.getTime() + s * 1000);
}
