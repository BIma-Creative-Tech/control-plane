/**
 * Tenant (SaaS Fase 1 W5, ADR 0017/0018, kontrak v1.2): onboarding satu form, suspend/resume override, ulangi rantai
 * dari langkah gagal, dan sync realm. Modul MURNI (tanpa Next/DB) — diuji unit: validasi form (slug, host per aturan
 * HOST job-contract), komposisi rantai job (urutan + args persis per instance), keputusan approve kc_realm_sync.
 * Pemanggil (jobs/tenants.ts) memuat data dari DB lalu memanggil fungsi di sini.
 */
import { z } from "zod";
import {
  APPROVE_ENVS,
  EMAIL_MAX,
  EMAIL_REGEX,
  FQDN_REGEX,
  INSTANCE_ENVS,
  NAME_MAX,
  PLATFORM_SLUG,
  asciiName,
  dbNameFor,
  defaultHost,
  isValidHostForEnv,
  type BridgeJobType,
  type Instance,
  type TenantEnv,
} from "./job-contract";
import { formToObject } from "./job-forms";
import { SLUG_REGEX } from "./slug";
import type { ChainStep } from "./user-admin";

// ---------------------------------------------------------------------------
// Environment (logika sama dengan form "Tambah environment" — dipakai keduanya)
// ---------------------------------------------------------------------------
/** env → instance Odoo (scripts/lib/odoo-pools.sh pool_for_env). */
export const ODOO_INSTANCE: Record<TenantEnv, string> = { prod: "pool-a", demo: "pool-a", staging: "staging" };

/** Nilai baris `environments` baru; kolom status TIDAK diisi (default absent/none, diperbarui dari RESULT job). */
export function environmentRowValues(slug: string, kind: TenantEnv, host: string) {
  return { kind, odooInstance: ODOO_INSTANCE[kind], dbName: dbNameFor(slug, kind), url: `https://${host}` };
}

// ---------------------------------------------------------------------------
// Fitur per instance (allowlist INFRA_JOBS_TYPES)
// ---------------------------------------------------------------------------
export const ONBOARDING_TYPES: readonly BridgeJobType[] = [
  "kc_org_ensure",
  "odoo_db_provision",
  "odoo_route",
  "odoo_sso_provision",
  "odoo_tenant_config",
  "kc_user_ensure",
  "kc_user_set_roles",
  "odoo_user_ensure",
];
export const TENANT_STATE_TYPES: readonly BridgeJobType[] = ["tenant_suspend", "tenant_resume"];
export const REALM_SYNC_TYPES: readonly BridgeJobType[] = ["kc_realm_sync"];

export function typesEnabled(allowed: readonly BridgeJobType[], need: readonly BridgeJobType[]): boolean {
  return need.every((t) => allowed.includes(t));
}

// ---------------------------------------------------------------------------
// Form onboarding
// ---------------------------------------------------------------------------
export interface OnboardingEnv {
  kind: TenantEnv;
  host: string;
}

export interface OnboardingInput {
  slug: string;
  name: string;
  brand: string | null;
  adminEmail: string;
  adminName: string;
  envs: OnboardingEnv[];
  /**
   * Plan Odoo opsional (integrasi Fase 1): bila dipilih, langganan `implementation` dibuat di transaksi yang sama
   * (billing/service.ts createSubscriptionTx; plan harus aktif dan layanan `odoo`, diverifikasi ulang di server).
   */
  planId: string | null;
}

export type OnboardingFormIssue = "invalid" | "slug_reserved" | "name_invalid" | "host_invalid";

const checkbox = z
  .union([z.literal("on"), z.literal("true")])
  .optional()
  .transform((v) => v !== undefined);
const optionalHost = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .transform((v) => (v === "" ? undefined : v))
  .pipe(z.string().regex(FQDN_REGEX).optional())
  .optional();
const common = {
  slug: z.string().trim().regex(SLUG_REGEX),
  name: z.string().trim().min(1).max(200),
  brand: z
    .string()
    .trim()
    .max(100)
    .transform((v) => (v === "" ? undefined : v))
    .optional(),
  admin_email: z.string().trim().toLowerCase().max(EMAIL_MAX).regex(EMAIL_REGEX),
  admin_name: z.string().trim().min(1).max(NAME_MAX * 2),
  plan_id: z
    .string()
    .trim()
    .transform((v) => (v === "" ? undefined : v))
    .pipe(z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/).optional())
    .optional(),
};

/** Field per instance: prod-inst → prod (+ demo opsional dengan host wajib); staging-inst → staging. */
const onboardingSchemas = {
  prod: z.object({ ...common, prod_host: optionalHost, demo: checkbox, demo_host: optionalHost }).strict(),
  staging: z.object({ ...common, staging_host: optionalHost }).strict(),
} as const;

/**
 * FormData → input onboarding. Aturan host = aturan HOST job-contract (subdomain platform per env); demo wajib host
 * dan tidak boleh sama dengan host prod. Slug `platform` reserved (kontrak §0.1). Nama admin ASCII saja (NAME_RE).
 */
export function parseOnboardingForm(
  instance: Instance,
  entries: Iterable<[string, FormDataEntryValue]>,
): { success: true; data: OnboardingInput } | { success: false; issue: OnboardingFormIssue } {
  const obj = formToObject(entries);
  if (!obj) return { success: false, issue: "invalid" };
  const r = onboardingSchemas[instance].safeParse(obj);
  if (!r.success) return { success: false, issue: "invalid" };
  const d = r.data as z.infer<(typeof onboardingSchemas)["prod"]> & z.infer<(typeof onboardingSchemas)["staging"]>;
  if (d.slug === PLATFORM_SLUG) return { success: false, issue: "slug_reserved" };
  const adminName = asciiName(d.admin_name);
  if (adminName === null) return { success: false, issue: "name_invalid" };

  const envs: OnboardingEnv[] = [];
  const add = (kind: TenantEnv, override: string | undefined): boolean => {
    const host = override ?? defaultHost(d.slug, kind);
    if (!host || !isValidHostForEnv(host, kind)) return false;
    envs.push({ kind, host });
    return true;
  };
  if (instance === "prod") {
    if (!add("prod", d.prod_host)) return { success: false, issue: "host_invalid" };
    if (d.demo) {
      if (!d.demo_host || !add("demo", d.demo_host)) return { success: false, issue: "host_invalid" };
    } else if (d.demo_host) {
      return { success: false, issue: "invalid" };
    }
  } else if (!add("staging", d.staging_host)) {
    return { success: false, issue: "host_invalid" };
  }
  if (new Set(envs.map((e) => e.host)).size !== envs.length) return { success: false, issue: "host_invalid" };
  for (const e of envs) if (!INSTANCE_ENVS[instance].includes(e.kind)) return { success: false, issue: "invalid" };

  return {
    success: true,
    data: { slug: d.slug, name: d.name, brand: d.brand ?? null, adminEmail: d.admin_email, adminName, envs, planId: d.plan_id ?? null },
  };
}

/**
 * Diagnosa (log saja) saat parseOnboardingForm → `invalid`: NAMA field yang gagal skema, tidak pernah nilainya. Kunci
 * tak dikenal (strict) diberi awalan `+` dan dipotong (nama kunci berasal dari klien). Urutan stabil, tanpa duplikat.
 */
export function onboardingInvalidFields(instance: Instance, entries: Iterable<[string, FormDataEntryValue]>): string[] {
  const obj = formToObject(entries);
  if (!obj) return ["(form: field ganda/berkas)"];
  const r = onboardingSchemas[instance].safeParse(obj);
  if (r.success) return [];
  const out = new Set<string>();
  for (const issue of r.error.issues) {
    if (issue.code === "unrecognized_keys") for (const k of issue.keys.slice(0, 10)) out.add(`+${String(k).slice(0, 40)}`);
    else out.add(String(issue.path[0] ?? "(form)"));
  }
  return [...out];
}

// ---------------------------------------------------------------------------
// Komposisi rantai
// ---------------------------------------------------------------------------
/**
 * SATU rantai per tenant (W5): kc_org_ensure → per env [odoo_db_provision → odoo_route → odoo_sso_provision →
 * odoo_tenant_config(compat)] → kc_user_ensure(admin, undangan) → per env kc_user_set_roles(client_admin, odoo=admin)
 * (role Odoo per client env) → per env odoo_user_ensure(admin, active). Job identitas memakai env realm instance.
 */
export function buildOnboardingSteps(p: {
  tenantId: string;
  realmEnv: TenantEnv;
  envs: readonly OnboardingEnv[];
  adminEmail: string;
  adminName: string | null;
}): ChainStep[] {
  const steps: ChainStep[] = [{ type: "kc_org_ensure", env: p.realmEnv, args: { tenant_id: p.tenantId } }];
  for (const e of p.envs) {
    steps.push(
      { type: "odoo_db_provision", env: e.kind, args: { host: e.host } },
      { type: "odoo_route", env: e.kind, args: { host: e.host, remove: false } },
      { type: "odoo_sso_provision", env: e.kind, args: { hosts: [e.host], rotate_secret: false, skip_smoke: false } },
      { type: "odoo_tenant_config", env: e.kind, args: { tenant_check: "compat" } },
    );
  }
  const name = p.adminName ? { name: p.adminName } : {};
  steps.push({ type: "kc_user_ensure", env: p.realmEnv, args: { email: p.adminEmail, tenant_id: p.tenantId, invite: true, ...name } });
  for (const e of p.envs) {
    steps.push({ type: "kc_user_set_roles", env: e.kind, args: { email: p.adminEmail, cp_role: "client_admin", odoo: "admin" } });
  }
  for (const e of p.envs) {
    steps.push({ type: "odoo_user_ensure", env: e.kind, args: { email: p.adminEmail, role: "admin", active: true, ...name } });
  }
  return steps;
}

export type TenantStateAction = "suspend" | "resume";

/** Suspend/Resume override: satu langkah per environment tenant yang dilayani instance ini. */
export function buildTenantStateSteps(action: TenantStateAction, envs: readonly { kind: TenantEnv }[]): ChainStep[] {
  const type = action === "suspend" ? "tenant_suspend" : "tenant_resume";
  return envs.map((e) => ({ type, env: e.kind, args: {} }));
}

/** Konfirmasi aksi berisiko: ketik slug persis (tanpa normalisasi selain trim). */
export function confirmMatches(typed: string | null | undefined, expected: string): boolean {
  return typeof typed === "string" && typed.trim() === expected && expected.length > 0;
}

// ---------------------------------------------------------------------------
// Ulangi rantai dari langkah gagal
// ---------------------------------------------------------------------------
export interface RetryChainRow {
  id: string;
  type: string;
  env: string | null;
  status: string;
  errorCode: string | null;
  dryRun: boolean;
  args: Record<string, unknown>;
}

export type RetryIssue =
  | "not_in_chain"
  | "not_failed"
  | "earlier_unfinished"
  | "chain_active"
  /** Rantai bukan dari aksi tenant/realm (mis. rantai Users — diulang lewat aksinya sendiri dengan otorisasi penuh). */
  | "origin"
  /** User target rantai kini `disabled` — mengulang bisa memberi akses lagi (BUG-J5-01: tidak pernah memberi hak lebih). */
  | "target_disabled"
  /** Langkah menyasar akun aktor sendiri. */
  | "self_target";

/**
 * Aksi audit asal rantai yang boleh diulang dari halaman tenant (audit `metadata.chain_id`): onboarding (dan ulangan
 * onboarding) dan pendaftaran tenant lama (`tenant.register_existing`: hanya kc_org_ensure/odoo_tenant_config — tanpa
 * langkah route/SSO/DB; rantai juga menolak langkah itu untuk environment route manual) SAJA. Tidak boleh (QA ronde 2,
 * keputusan Lead):
 * - rantai Users (`user.*`) — aturan authorizeUserMutation hanya berlaku lewat aksi Users itu sendiri;
 * - `realm.sync_*` (N1) — sync realm hanya lewat /realm (decideRealmSync: rencana segar tanpa blocker + approve prod);
 * - `tenant.suspend|resume` (N3) — ulang manual lewat tombol berkonfirmasi slug (cek kebalikan aktif).
 */
export const RETRYABLE_CHAIN_ORIGINS = ["tenant.onboard", "chain.retry", "tenant.register_existing"] as const;

export function retryableOrigin(action: string | null | undefined): boolean {
  return typeof action === "string" && (RETRYABLE_CHAIN_ORIGINS as readonly string[]).includes(action);
}

const FINAL = new Set(["succeeded", "failed", "cancelled"]);
const ENVS: readonly string[] = ["prod", "demo", "staging"];

/**
 * Rantai baru = langkah `fromId` (failed, atau cancelled bukan karena chain_aborted) + semua langkah sesudahnya,
 * args/env/dry-run sama persis (divalidasi ulang kontrak saat enqueue). Langkah sebelumnya harus succeeded; tidak
 * boleh ada langkah aktif di rantai lama (mencegah dua rantai menjalankan langkah yang sama). `ordered` = urutan
 * after_job_id (orderChain).
 */
export function retryStepsFrom(ordered: readonly RetryChainRow[], fromId: string): { ok: true; steps: ChainStep[] } | { ok: false; issue: RetryIssue } {
  const i = ordered.findIndex((r) => r.id === fromId);
  if (i < 0) return { ok: false, issue: "not_in_chain" };
  const from = ordered[i]!;
  const retryable = from.status === "failed" || (from.status === "cancelled" && from.errorCode !== "chain_aborted");
  if (!retryable) return { ok: false, issue: "not_failed" };
  if (ordered.slice(0, i).some((r) => r.status !== "succeeded")) return { ok: false, issue: "earlier_unfinished" };
  if (ordered.some((r) => !FINAL.has(r.status))) return { ok: false, issue: "chain_active" };
  const steps: ChainStep[] = [];
  for (const r of ordered.slice(i)) {
    if (!r.env || !ENVS.includes(r.env)) return { ok: false, issue: "not_in_chain" };
    steps.push({ type: r.type as BridgeJobType, env: r.env as TenantEnv, args: r.args, ...(r.dryRun ? { dryRun: true } : {}) });
  }
  return { ok: true, steps };
}

// ---------------------------------------------------------------------------
// kc_realm_sync
// ---------------------------------------------------------------------------
/** Realm per env (kontrak §0.2): prod|demo → `platform`, staging → `platform-staging`. */
export function realmNameForEnv(env: TenantEnv): string {
  return env === "staging" ? "platform-staging" : "platform";
}

/** Rencana (dry-run) terakhir: dipakai sebagai prasyarat apply. */
export interface RealmPlanFact {
  status: string;
  finishedAt: Date | null;
  result: Record<string, string> | null;
}

/** Rencana dianggap segar ≤ 24 jam. */
export const REALM_PLAN_MAX_AGE_MS = 24 * 3600_000;

export type RealmSyncDecision =
  | { ok: true; step: ChainStep }
  | { ok: false; code: "confirm" | "approve_required" | "plan_required" };

/**
 * Keputusan kc_realm_sync (murni):
 * - plan: dry_run=true, args `{}`;
 * - apply: wajib ketik nama realm; rencana terakhir harus succeeded ≤ 24 jam dengan blockers=0 (ADR 0017 D7 "selalu
 *   dry-run dulu"); env prod/demo → `approve=true` HANYA bila checkbox persetujuan dicentang (kontrak §1), staging
 *   tidak pernah mengirim `approve`.
 */
export function decideRealmSync(p: {
  realmEnv: TenantEnv;
  mode: "plan" | "apply";
  confirmRealm?: string | null;
  approveChecked?: boolean;
  lastPlan: RealmPlanFact | null;
  now: Date;
}): RealmSyncDecision {
  if (p.mode === "plan") return { ok: true, step: { type: "kc_realm_sync", env: p.realmEnv, args: {}, dryRun: true } };
  if (!confirmMatches(p.confirmRealm, realmNameForEnv(p.realmEnv))) return { ok: false, code: "confirm" };
  const needApprove = APPROVE_ENVS.includes(p.realmEnv);
  if (needApprove && p.approveChecked !== true) return { ok: false, code: "approve_required" };
  const lp = p.lastPlan;
  const fresh = lp?.finishedAt ? p.now.getTime() - lp.finishedAt.getTime() <= REALM_PLAN_MAX_AGE_MS : false;
  // N7 (fail-closed): RESULT `blockers` WAJIB ada dan = "0"; tidak ada → rencana dianggap tidak bersih.
  const blockers = lp?.result?.blockers;
  if (!lp || lp.status !== "succeeded" || !fresh || blockers !== "0") return { ok: false, code: "plan_required" };
  return { ok: true, step: { type: "kc_realm_sync", env: p.realmEnv, args: needApprove ? { approve: true } : {} } };
}

// ---------------------------------------------------------------------------
// Form kecil (Server Action, Zod .strict())
// ---------------------------------------------------------------------------
const uuidField = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

export const tenantFormSchemas = {
  tenantState: z
    .object({ clientId: uuidField, action: z.enum(["suspend", "resume"]), confirm: z.string().max(64) })
    .strict(),
  realmPlan: z.object({}).strict(),
  realmApply: z.object({ confirm: z.string().max(64), approve: checkbox }).strict(),
} as const;

export type TenantFormName = keyof typeof tenantFormSchemas;

export function parseTenantForm<N extends TenantFormName>(name: N, entries: Iterable<[string, FormDataEntryValue]>) {
  const obj = formToObject(entries);
  if (!obj) return { success: false as const };
  const r = tenantFormSchemas[name].safeParse(obj);
  return r.success ? { success: true as const, data: r.data as z.infer<(typeof tenantFormSchemas)[N]> } : { success: false as const };
}
