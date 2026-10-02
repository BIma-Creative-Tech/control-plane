/**
 * "Daftarkan tenant yang sudah ada" (migrasi prod M8, `docs/plans/saas-migration-prod.md` repo infra) — modul MURNI
 * (diuji unit). Tenant yang sudah hidup di luar control plane (DB, route — boleh host KUSTOM —, client Keycloak SSO)
 * dicatat ke `clients` + `environments` TANPA provisioning baru: status environment = deklarasi operator
 * (db provisioned, route active, sso active|none). Rantai job hanya `kc_org_ensure` (+ `odoo_tenant_config` compat per
 * env ber-SSO aktif) — keduanya tunduk allowlist instance; tidak ada langkah route/SSO/DB.
 *
 * Aturan:
 * - slug = aturan slug biasa; `platform` dicadangkan; slug terpakai → `exists` (unique index, di layanan);
 * - `db_name` WAJIB = konvensi `<slug '-'→'_'>_<env>` — dispatcher menurunkan nama DB dari slug+env, nama lain tidak
 *   akan pernah tersentuh job;
 * - host boleh kustom (FQDN generik), tetapi host di zona platform (PLATFORM_DOMAINS) wajib lolos regex HOST env-nya
 *   (host platform tidak boleh "manual"); host antar-env berbeda;
 * - environment ber-host di luar regex HOST platform = route manual (job-contract `routeManagedManually`).
 */
import { z } from "zod";
import {
  FQDN_REGEX,
  INSTANCE_ENVS,
  PLATFORM_SLUG,
  blockedForManualRoute,
  dbNameFor,
  envAllowedForInstance,
  isValidHostForEnv,
  routeManagedManually,
  type BridgeJobType,
  type Instance,
  type TenantEnv,
} from "./job-contract";
import { DEFAULT_PLATFORM_DOMAINS, isPlatformFqdn } from "./domains";
import { formToObject } from "./job-forms";
import { SLUG_REGEX } from "./slug";
import { ODOO_INSTANCE } from "./tenant-onboarding";
import type { ChainStep } from "./user-admin";

/** Tipe job rantai pendaftaran (masing-masing tunduk allowlist INFRA_JOBS_TYPES instance). */
export const REGISTER_EXISTING_TYPES: readonly BridgeJobType[] = ["kc_org_ensure", "odoo_tenant_config"];

/** Teks UI untuk environment route manual (tombol job route/SSO dinonaktifkan). */
export const MANUAL_ROUTE_NOTE = "Route manual — diadopsi di Fase 2";

export const REGISTER_SSO_STATUSES = ["active", "none"] as const;
export type RegisterSsoStatus = (typeof REGISTER_SSO_STATUSES)[number];

export interface RegisterEnv {
  kind: TenantEnv;
  host: string;
  dbName: string;
  /** Deklarasi: DB sudah ada. */
  dbStatus: "provisioned";
  /** Deklarasi: route sudah aktif (dirender manual bila host kustom). */
  routeStatus: "active";
  ssoStatus: RegisterSsoStatus;
}

export interface RegisterExistingInput {
  slug: string;
  name: string;
  brand: string | null;
  envs: RegisterEnv[];
  /** Plan Odoo opsional → langganan `implementation` (createSubscriptionTx, transaksi yang sama). */
  planId: string | null;
}

export type RegisterFormIssue = "invalid" | "slug_reserved" | "host_invalid" | "db_name_mismatch" | "no_env";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === "" ? undefined : v))
    .optional();
const checkbox = z
  .union([z.literal("on"), z.literal("true")])
  .optional()
  .transform((v) => v !== undefined);

function envFields(kind: TenantEnv) {
  return {
    [kind]: checkbox,
    [`${kind}_db_name`]: optionalText(63),
    [`${kind}_host`]: z
      .string()
      .trim()
      .toLowerCase()
      .max(253)
      .transform((v) => (v === "" ? undefined : v))
      .optional(),
    [`${kind}_db_status`]: z.literal("provisioned").optional(),
    [`${kind}_route_status`]: z.literal("active").optional(),
    [`${kind}_sso_status`]: z.enum(REGISTER_SSO_STATUSES).optional(),
  };
}

function registerSchema(instance: Instance) {
  const common = {
    slug: z.string().trim().regex(SLUG_REGEX),
    name: z.string().trim().min(1).max(200),
    brand: optionalText(100),
    plan_id: z
      .string()
      .trim()
      .transform((v) => (v === "" ? undefined : v))
      .pipe(z.string().regex(UUID).optional())
      .optional(),
  };
  const fields = Object.assign({}, ...INSTANCE_ENVS[instance].map(envFields)) as Record<string, z.ZodType>;
  return z.object({ ...common, ...fields }).strict();
}

/**
 * Validasi input pendaftaran (murni) — dipakai parser form DAN layanan (pertahanan berlapis bila layanan dipanggil
 * langsung). `null` = valid.
 */
export function validateRegisterInput(
  instance: Instance,
  f: RegisterExistingInput,
  platformDomains: readonly string[] = DEFAULT_PLATFORM_DOMAINS,
): RegisterFormIssue | null {
  if (f.slug === PLATFORM_SLUG) return "slug_reserved";
  if (!SLUG_REGEX.test(f.slug)) return "invalid";
  if (f.envs.length === 0) return "no_env";
  if (new Set(f.envs.map((e) => e.kind)).size !== f.envs.length) return "invalid";
  for (const e of f.envs) {
    if (!envAllowedForInstance(instance, e.kind)) return "no_env";
    if (e.dbStatus !== "provisioned" || e.routeStatus !== "active") return "invalid";
    if (!(REGISTER_SSO_STATUSES as readonly string[]).includes(e.ssoStatus)) return "invalid";
    if (e.dbName !== dbNameFor(f.slug, e.kind)) return "db_name_mismatch";
    if (e.host.length > 253 || !FQDN_REGEX.test(e.host)) return "host_invalid";
    // Host di zona platform dikelola platform → wajib host platform yang sah untuk env-nya (bukan "manual").
    if (isPlatformFqdn(e.host, platformDomains) && !isValidHostForEnv(e.host, e.kind)) return "host_invalid";
  }
  if (new Set(f.envs.map((e) => e.host)).size !== f.envs.length) return "host_invalid";
  return null;
}

/**
 * FormData → input pendaftaran. Per env instance ini: checkbox `<env>` + `<env>_db_name`, `<env>_host`,
 * `<env>_db_status` (provisioned), `<env>_route_status` (active), `<env>_sso_status` (active|none). Env tidak
 * dicentang tetapi db_name/host terisi → `invalid` (mencegah salah centang).
 */
export function parseRegisterExistingForm(
  instance: Instance,
  entries: Iterable<[string, FormDataEntryValue]>,
  platformDomains: readonly string[] = DEFAULT_PLATFORM_DOMAINS,
): { success: true; data: RegisterExistingInput } | { success: false; issue: RegisterFormIssue } {
  const obj = formToObject(entries);
  if (!obj) return { success: false, issue: "invalid" };
  const r = registerSchema(instance).safeParse(obj);
  if (!r.success) return { success: false, issue: "invalid" };
  const d = r.data as Record<string, unknown> & { slug: string; name: string; brand?: string; plan_id?: string };
  if (d.slug === PLATFORM_SLUG) return { success: false, issue: "slug_reserved" };

  const envs: RegisterEnv[] = [];
  for (const kind of INSTANCE_ENVS[instance]) {
    const on = d[kind] === true;
    const dbName = d[`${kind}_db_name`] as string | undefined;
    const host = d[`${kind}_host`] as string | undefined;
    if (!on) {
      if (dbName || host) return { success: false, issue: "invalid" };
      continue;
    }
    const dbStatus = d[`${kind}_db_status`];
    const routeStatus = d[`${kind}_route_status`];
    const ssoStatus = d[`${kind}_sso_status`] as RegisterSsoStatus | undefined;
    if (!dbName || dbStatus !== "provisioned" || routeStatus !== "active" || !ssoStatus) return { success: false, issue: "invalid" };
    if (!host) return { success: false, issue: "host_invalid" };
    envs.push({ kind, host, dbName, dbStatus: "provisioned", routeStatus: "active", ssoStatus });
  }
  const data: RegisterExistingInput = { slug: d.slug, name: d.name, brand: d.brand ?? null, envs, planId: d.plan_id ?? null };
  const issue = validateRegisterInput(instance, data, platformDomains);
  if (issue) return { success: false, issue };
  return { success: true, data };
}

/** Nilai baris `environments` tenant yang didaftarkan: status = deklarasi operator (bukan RESULT job). */
export function registeredEnvironmentRowValues(e: RegisterEnv) {
  return {
    kind: e.kind,
    odooInstance: ODOO_INSTANCE[e.kind],
    dbName: e.dbName,
    url: `https://${e.host}`,
    host: e.host,
    dbStatus: e.dbStatus,
    routeStatus: e.routeStatus,
    ssoStatus: e.ssoStatus,
  };
}

/**
 * Rantai pendaftaran: `kc_org_ensure` (tenant_id) lalu `odoo_tenant_config(compat)` per env ber-SSO aktif. Tipe di luar
 * allowlist instance DILEWATI (`skipped`) — bila semuanya dilewati, hanya baris DB yang dicatat. Tidak pernah ada langkah
 * odoo_db_provision/odoo_route/odoo_sso_* (rantai onboarding tidak berlaku untuk tenant yang sudah ada).
 */
export function buildRegisterExistingSteps(p: {
  tenantId: string;
  realmEnv: TenantEnv;
  envs: readonly Pick<RegisterEnv, "kind" | "ssoStatus">[];
  allowedTypes: readonly BridgeJobType[];
}): { steps: ChainStep[]; skipped: BridgeJobType[] } {
  const all: ChainStep[] = [{ type: "kc_org_ensure", env: p.realmEnv, args: { tenant_id: p.tenantId } }];
  for (const e of p.envs) {
    if (e.ssoStatus === "active") all.push({ type: "odoo_tenant_config", env: e.kind, args: { tenant_check: "compat" } });
  }
  const steps = all.filter((s) => p.allowedTypes.includes(s.type));
  const skipped = [...new Set(all.filter((s) => !p.allowedTypes.includes(s.type)).map((s) => s.type))];
  return { steps, skipped };
}

/** Metadata audit `tenant.register_existing` (tanpa PII: slug, brand, env, nama DB, host, status deklarasi). */
export function registerAuditMetadata(f: RegisterExistingInput): Record<string, unknown> {
  return {
    slug: f.slug,
    ...(f.brand ? { brand: f.brand } : {}),
    ...(f.planId ? { plan_id: f.planId } : {}),
    envs: f.envs.map((e) => e.kind),
    environments: f.envs.map((e) => ({
      kind: e.kind,
      db_name: e.dbName,
      host: e.host,
      db: e.dbStatus,
      route: e.routeStatus,
      sso: e.ssoStatus,
      route_manual: !isValidHostForEnv(e.host, e.kind),
    })),
  };
}

/**
 * Ketersediaan tombol job halaman environment (murni). Route manual → provision DB, route, dan SSO (provision/rotasi/
 * nonaktif) dimatikan dengan catatan MANUAL_ROUTE_NOTE; layanan menolak hal yang sama (`route_manual`).
 */
export function environmentJobAvailability(e: { kind: TenantEnv; host: string | null; url: string }): {
  manualRoute: boolean;
  dbProvision: boolean;
  route: boolean;
  sso: boolean;
  note: string | null;
} {
  const manual = routeManagedManually(e);
  return {
    manualRoute: manual,
    dbProvision: !(manual && blockedForManualRoute("odoo_db_provision")),
    route: !(manual && blockedForManualRoute("odoo_route")),
    sso: !(manual && blockedForManualRoute("odoo_sso_provision")),
    note: manual ? MANUAL_ROUTE_NOTE : null,
  };
}
