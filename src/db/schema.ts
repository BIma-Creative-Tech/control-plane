/**
 * Skema control plane (CLAUDE.md §3.4, .claude/agents/nextjs-developer.md §Control plane).
 * API diverifikasi dari drizzle-orm 0.45.3 (node_modules/drizzle-orm/pg-core/*.d.ts):
 * pgTable(name, columns, (t) => [index(..).on(..), check(..)]).
 *
 * Konvensi: PK uuid (gen_random_uuid, bawaan PG13+), timestamp with time zone, snake_case.
 * Perubahan skema = `npm run db:generate` → migrasi SQL baru di ./drizzle (versi berurutan).
 */
import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  check,
  char,
  date,
  index,
  inet,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// Enum
// ---------------------------------------------------------------------------
export const userRole = pgEnum("user_role", ["superadmin", "ops", "client_admin", "client_user"]);

/**
 * Siklus langganan ADR 0018 D4 (migrasi 0005 menambah `implementation`, `warranty`, `past_due` di AKHIR enum).
 * `pending` dan `grace` USANG: Postgres tidak bisa menghapus nilai enum — kode baru tidak pernah menulisnya
 * (lib/billing.ts memperlakukannya sebagai status tanpa transisi). Default kolom tetap `pending` di DB (nilai enum
 * baru tidak boleh dipakai di transaksi migrasi yang sama) — kode SELALU mengisi status eksplisit.
 */
export const subscriptionStatus = pgEnum("subscription_status", [
  "pending",
  "active",
  "grace",
  "suspended",
  "terminated",
  "implementation",
  "warranty",
  "past_due",
]);

/** ADR 0018 D7 (migrasi 0005): layanan yang dijual per plan. */
export const planService = pgEnum("plan_service", ["odoo", "insight", "mail", "web"]);

/** ADR 0018 D4 (migrasi 0005): invoice implementasi (manual) vs maintenance (per periode). */
export const invoiceKind = pgEnum("invoice_kind", ["implementation", "maintenance"]);

/** ADR 0018 D1 (migrasi 0005): kegunaan domain tenant. */
export const domainPurpose = pgEnum("domain_purpose", ["odoo", "web", "mail", "insight", "sso"]);

export const invoiceStatus = pgEnum("invoice_status", ["unpaid", "awaiting_confirmation", "paid", "void"]);

/** Metode bayar. Fase ini hanya transfer manual; gateway ditambah sebagai nilai enum baru. */
export const paymentMethod = pgEnum("payment_method", ["manual_transfer"]);

export const domainStatus = pgEnum("domain_status", ["pending_dns", "verified", "active", "failed"]);

export const environmentKind = pgEnum("environment_kind", ["prod", "demo", "staging"]);

export const jobType = pgEnum("job_type", [
  "noop",
  "provision",
  "suspend",
  "resume",
  "terminate",
  "backup_now",
  "restore",
  // Plan 05 §4.2 (ADR 0009) — dijalankan dispatcher root `infra-job` lewat spool.
  "odoo_db_provision",
  "odoo_route",
  "odoo_sso_provision",
  "odoo_sso_disable",
  "odoo_sso_user",
  // SaaS Fase 1 (kontrak saas-phase-1-contract.md §1, migrasi 0004) — identitas/tenant lewat dispatcher.
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
]);

/** `dispatched` = file job sudah ditulis ke spool, hasil belum ada (plan 05 §4.3). */
export const jobStatus = pgEnum("job_status", ["queued", "dispatched", "running", "succeeded", "failed", "cancelled"]);

export const envDbStatus = pgEnum("env_db_status", ["absent", "provisioned"]);
export const envRouteStatus = pgEnum("env_route_status", ["absent", "active", "removed"]);
export const envSsoStatus = pgEnum("env_sso_status", ["none", "active", "disabled"]);
/**
 * `inconsistent` (BUG-J5-01, migrasi 0003): RESULT job `odoo_sso_user` tidak cocok dengan aksi yang diminta
 * (mis. resend_invite dilaporkan `action=grant`) — status nyata di Keycloak/Odoo tidak diketahui CP; perlu
 * pemeriksaan ops (revoke/grant eksplisit). Tidak pernah diisi dari input form.
 */
export const tenantUserStatus = pgEnum("tenant_user_status", ["pending", "active", "revoked", "failed", "inconsistent"]);

/** Kode error job (plan 05 §4.3) — sama dengan CHECK `provision_jobs_error_code_valid`. */
export const JOB_ERROR_CODES = [
  "rejected_validation",
  "rejected_quota",
  "disabled",
  "blocked_dry_run",
  "locked",
  "timeout_state_unknown",
  "script_exit",
  "no_result",
  // CP saja (Lead J2b): worker gagal menulis file job ke spool.
  "spool_error",
  // CP saja (BUG-J5-01, migrasi 0003): RESULT tidak konsisten dengan aksi yang diminta.
  "result_inconsistent",
  // CP saja (kontrak Fase 1 §2.1, migrasi 0004): job sebelumnya di rantai (after_job_id) gagal/dibatalkan.
  "chain_aborted",
] as const;

export const mailboxStatus = pgEnum("mailbox_status", ["active", "suspended", "deleted"]);

/** ADR 0018 D1 (migrasi 0004): status tenant & model isolasi. */
export const tenantStatus = pgEnum("tenant_status", ["active", "suspended", "terminated"]);
export const tenantIsolation = pgEnum("tenant_isolation", ["shared", "dedicated"]);
/**
 * ADR 0018 D1 (migrasi 0004): `invited` = dibuat lewat job `kc_user_ensure` (belum pernah login),
 * `active` = pernah login / diaktifkan ulang, `disabled` = dinonaktifkan lewat `kc_user_set_enabled`.
 */
export const userStatus = pgEnum("user_status", ["invited", "active", "disabled"]);

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

// ---------------------------------------------------------------------------
// Client & user
// ---------------------------------------------------------------------------
export const clients = pgTable(
  "clients",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Slug = kunci nama DB/hostname/skrip; wajib cocok ^[a-z0-9-]{3,30}$ (whitelist orkestrasi). */
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    contactEmail: text("contact_email"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    /** Terminasi logis; data dihapus setelah grace 30 hari (job terminate). */
    terminatedAt: timestamp("terminated_at", { withTimezone: true }),
    // --- ADR 0018 D1 (migrasi 0004, aditif). ---
    status: tenantStatus("status").notNull().default("active"),
    isolation: tenantIsolation("isolation").notNull().default("shared"),
    brand: text("brand"),
    /** id Organization Keycloak (RESULT `org` job kc_org_ensure). */
    kcOrgId: text("kc_org_id"),
    /** Tenant internal `platform` (user superadmin/ops) — tepat satu baris (partial unique index). */
    isPlatform: boolean("is_platform").notNull().default(false),
  },
  (t) => [
    uniqueIndex("clients_slug_uq").on(t.slug),
    check("clients_slug_format", sql`${t.slug} ~ '^[a-z0-9-]{3,30}$'`),
    uniqueIndex("clients_one_platform_uq").on(t.isPlatform).where(sql`${t.isPlatform}`),
  ],
);

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Claim `sub` Keycloak (identitas stabil). */
    keycloakSub: text("keycloak_sub").notNull(),
    email: text("email"),
    displayName: text("display_name"),
    /** Cache role terakhir dari claim; otorisasi tetap memakai claim sesi. */
    role: userRole("role").notNull().default("client_user"),
    /** Wajib untuk client_admin/client_user; null untuk superadmin/ops. */
    clientId: uuid("client_id").references(() => clients.id, { onDelete: "restrict" }),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    // --- ADR 0018 D1 (migrasi 0004, aditif). Diisi dari RESULT job, bukan dari input form. ---
    status: userStatus("status").notNull().default("active"),
    invitedBy: uuid("invited_by").references((): AnyPgColumn => users.id, { onDelete: "set null" }),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("users_keycloak_sub_uq").on(t.keycloakSub),
    index("users_client_idx").on(t.clientId),
    // ADR 0018 D3: ≤ 1 tenant-admin invited/active per tenant.
    uniqueIndex("users_one_tenant_admin_uq")
      .on(t.clientId)
      .where(sql`${t.role} = 'client_admin' AND ${t.status} IN ('invited', 'active')`),
  ],
);

// ---------------------------------------------------------------------------
// Plan, subscription, invoice
// ---------------------------------------------------------------------------
export const plans = pgTable(
  "plans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    /** ADR 0018 D7 (migrasi 0005): NULL = harga belum ditetapkan (diisi kemudian). */
    priceAmount: numeric("price_amount", { precision: 14, scale: 2 }),
    currency: char("currency", { length: 3 }).notNull().default("IDR"),
    billingPeriodMonths: integer("billing_period_months").notNull().default(1),
    maxUsers: integer("max_users"),
    maxEnvironments: integer("max_environments"),
    /** Batas mail (placeholder untuk plan mail, ADR 0005 #15). */
    maxMailboxes: integer("max_mailboxes"),
    features: jsonb("features").$type<Record<string, unknown>>().notNull().default({}),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    /** ADR 0018 D7 (migrasi 0005, nullable agar aditif). Seed (db/plans.ts) selalu mengisi. */
    service: planService("service"),
  },
  (t) => [
    uniqueIndex("plans_code_uq").on(t.code),
    check("plans_price_nonneg", sql`${t.priceAmount} >= 0`),
    check("plans_period_pos", sql`${t.billingPeriodMonths} > 0`),
  ],
);

export const subscriptions = pgTable(
  "subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "restrict" }),
    planId: uuid("plan_id")
      .notNull()
      .references(() => plans.id, { onDelete: "restrict" }),
    status: subscriptionStatus("status").notNull().default("pending"),
    currentPeriodStart: timestamp("current_period_start", { withTimezone: true }),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
    graceUntil: timestamp("grace_until", { withTimezone: true }),
    suspendedAt: timestamp("suspended_at", { withTimezone: true }),
    terminatedAt: timestamp("terminated_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    // --- ADR 0018 D4 (migrasi 0005, aditif). current_period_start = starts_at, current_period_end = ends_at
    // (disimpan 00:00 Asia/Jakarta, lib/billing.ts). Tanggal kalender WIB (string YYYY-MM-DD). ---
    goLiveAt: date("go_live_at", { mode: "string" }),
    warrantyUntil: date("warranty_until", { mode: "string" }),
    notes: text("notes"),
  },
  (t) => [index("subscriptions_client_idx").on(t.clientId), index("subscriptions_status_idx").on(t.status)],
);

/**
 * Invoice. Transfer manual: upload bukti (`proof_file` = kunci penyimpanan acak, bukan path dari user)
 * → admin konfirmasi (`confirmed_by`/`confirmed_at`) → status `paid`.
 * Siap gateway: `payment_method` (enum, tambah nilai baru), `payment_provider` + `payment_reference`
 * (id transaksi eksternal, unik per provider) untuk rekonsiliasi webhook kelak.
 */
export const invoices = pgTable(
  "invoices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    number: text("number").notNull(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "restrict" }),
    subscriptionId: uuid("subscription_id").references(() => subscriptions.id, { onDelete: "restrict" }),
    amount: numeric("amount", { precision: 14, scale: 2 }).notNull(),
    currency: char("currency", { length: 3 }).notNull().default("IDR"),
    status: invoiceStatus("status").notNull().default("unpaid"),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull().defaultNow(),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    paymentMethod: paymentMethod("payment_method").notNull().default("manual_transfer"),
    paymentProvider: text("payment_provider"),
    paymentReference: text("payment_reference"),
    proofFile: text("proof_file"),
    proofUploadedAt: timestamp("proof_uploaded_at", { withTimezone: true }),
    confirmedBy: uuid("confirmed_by").references(() => users.id, { onDelete: "restrict" }),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    voidReason: text("void_reason"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    // --- ADR 0018 D4 (migrasi 0005, aditif). ---
    kind: invoiceKind("kind").notNull().default("maintenance"),
    /** Referensi bukti bayar (teks bebas tervalidasi, mis. nomor mutasi) — Fase 1 tanpa upload file. */
    proofReference: text("proof_reference"),
    /** Periode maintenance yang ditagih (tanggal WIB); NULL untuk invoice implementasi. */
    periodStart: date("period_start", { mode: "string" }),
    periodEnd: date("period_end", { mode: "string" }),
  },
  (t) => [
    uniqueIndex("invoices_number_uq").on(t.number),
    uniqueIndex("invoices_payment_ref_uq").on(t.paymentProvider, t.paymentReference),
    index("invoices_client_idx").on(t.clientId),
    index("invoices_status_idx").on(t.status),
    check("invoices_amount_nonneg", sql`${t.amount} >= 0`),
    check(
      "invoices_paid_confirmed",
      sql`${t.status} <> 'paid' OR (${t.confirmedAt} IS NOT NULL AND ${t.paidAt} IS NOT NULL)`,
    ),
    check("invoices_proof_file_format", sql`${t.proofFile} IS NULL OR ${t.proofFile} ~ '^[A-Za-z0-9_-]{16,128}(\\.(png|jpg|pdf))?$'`),
    // Migrasi 0005: satu invoice maintenance non-void per (subscription, periode) — penerbitan tick idempoten.
    uniqueIndex("invoices_maintenance_period_uq")
      .on(t.subscriptionId, t.periodStart)
      .where(sql`${t.kind} = 'maintenance' AND ${t.status} <> 'void' AND ${t.periodStart} IS NOT NULL`),
    check("invoices_period_order", sql`${t.periodStart} IS NULL OR (${t.periodEnd} IS NOT NULL AND ${t.periodEnd} > ${t.periodStart})`),
  ],
);

// ---------------------------------------------------------------------------
// Environment & domain
// ---------------------------------------------------------------------------
export const environments = pgTable(
  "environments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "restrict" }),
    kind: environmentKind("kind").notNull(),
    /** Instance Odoo, mis. `pool-a` atau `dedicated-<slug>`. */
    odooInstance: text("odoo_instance").notNull(),
    /** Nama DB eksak (header X-Sh-Odoo-Db, CLAUDE.md §3.2): ^[a-z0-9_]{1,63}$, mis. acme_prod. */
    dbName: text("db_name").notNull(),
    url: text("url").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    // --- Plan 05 §7: diisi dari HASIL job (RESULT dispatcher), bukan dari input form. ---
    /** FQDN route tenant (RESULT host dari odoo_route). */
    host: text("host"),
    dbStatus: envDbStatus("db_status").notNull().default("absent"),
    routeStatus: envRouteStatus("route_status").notNull().default("absent"),
    ssoStatus: envSsoStatus("sso_status").notNull().default("none"),
    /** clientId Keycloak `odoo-<slug>-<env>` (RESULT client). */
    ssoClientId: text("sso_client_id"),
    /** id auth.oauth.provider di DB tenant (RESULT provider). */
    ssoProviderId: integer("sso_provider_id"),
    lastJobId: uuid("last_job_id").references((): AnyPgColumn => provisionJobs.id, { onDelete: "set null" }),
    /** Migrasi 0005: mode `sh_auth_oidc.tenant_check` dari RESULT `mode` job odoo_tenant_config (off|compat|strict). */
    tenantCheck: text("tenant_check"),
  },
  (t) => [
    uniqueIndex("environments_client_kind_uq").on(t.clientId, t.kind),
    uniqueIndex("environments_db_name_uq").on(t.dbName),
    check("environments_db_name_format", sql`${t.dbName} ~ '^[a-z0-9_]{1,63}$'`),
    check("environments_odoo_instance_format", sql`${t.odooInstance} ~ '^[a-z0-9-]{3,40}$'`),
    check(
      "environments_host_format",
      sql`${t.host} IS NULL OR (length(${t.host}) <= 253 AND ${t.host} ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,63}$')`,
    ),
    check("environments_sso_client_id_format", sql`${t.ssoClientId} IS NULL OR ${t.ssoClientId} ~ '^[A-Za-z0-9._-]{1,128}$'`),
    check("environments_tenant_check_valid", sql`${t.tenantCheck} IS NULL OR ${t.tenantCheck} IN ('off', 'compat', 'strict')`),
  ],
);

export const domains = pgTable(
  "domains",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "restrict" }),
    environmentId: uuid("environment_id").references(() => environments.id, { onDelete: "set null" }),
    /** FQDN huruf kecil, tanpa titik akhir. */
    fqdn: text("fqdn").notNull(),
    status: domainStatus("status").notNull().default("pending_dns"),
    /** Nilai TXT `_platform-verify.<fqdn>`; acak, dibuat server. */
    verificationToken: text("verification_token").notNull(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    lastError: text("last_error"),
    certificateStatus: text("certificate_status"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    // --- ADR 0018 D1 (migrasi 0005, aditif). ---
    purpose: domainPurpose("purpose"),
    /** Nilai TXT DKIM yang harus dipasang client (checklist DNS). */
    dkimTxt: text("dkim_txt"),
    /** Hasil cek DNS terakhir (bentuk ditentukan Fase 2 `dns_verify`). */
    lastCheck: jsonb("last_check").$type<Record<string, unknown>>(),
  },
  (t) => [
    uniqueIndex("domains_fqdn_uq").on(t.fqdn),
    index("domains_client_idx").on(t.clientId),
    check("domains_fqdn_lower", sql`${t.fqdn} = lower(${t.fqdn}) AND length(${t.fqdn}) <= 253`),
  ],
);

// ---------------------------------------------------------------------------
// Job orkestrasi & audit
// ---------------------------------------------------------------------------
/**
 * Antrean + audit orkestrasi. Request HTTP hanya INSERT baris ini + enqueue pg-boss;
 * worker terpisah yang mengeksekusi (belum memanggil skrip host di scaffold ini).
 */
export const provisionJobs = pgTable(
  "provision_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    type: jobType("type").notNull(),
    status: jobStatus("status").notNull().default("queued"),
    clientId: uuid("client_id").references(() => clients.id, { onDelete: "set null" }),
    /** Argumen tervalidasi (whitelist Zod) — bukan input mentah user. */
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    log: text("log").notNull().default(""),
    /** Migrasi 0005: ON DELETE RESTRICT (docs/temuan-users-prod-kosong.md) — baris users beraudit tidak bisa dihapus. */
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "restrict" }),
    /** `user:<sub>` atau `system:<komponen>`. */
    actor: text("actor").notNull(),
    bossJobId: text("boss_job_id"),
    attempts: integer("attempts").notNull().default(0),
    error: text("error"),
    createdAt: createdAt(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    // --- Plan 05 §7 (jembatan infra-job). Semua nullable/berdefault → image lama tetap jalan. ---
    environmentId: uuid("environment_id").references(() => environments.id, { onDelete: "set null" }),
    env: environmentKind("env"),
    dryRun: boolean("dry_run").notNull().default(false),
    exitCode: integer("exit_code"),
    errorCode: text("error_code"),
    /** RESULT ter-allowlist dari dispatcher (tanpa secret/secret_file). */
    result: jsonb("result").$type<Record<string, string>>(),
    parentJobId: uuid("parent_job_id").references((): AnyPgColumn => provisionJobs.id, { onDelete: "set null" }),
    dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
    deadlineAt: timestamp("deadline_at", { withTimezone: true }),
    // --- Kontrak Fase 1 §2.1 (migrasi 0004, aditif). ---
    /** `<type>:<slug>:<env>:<target>` — permintaan ganda mengembalikan job yang sama (lihat jobs/chain.ts). */
    idempotencyKey: text("idempotency_key"),
    /** Rantai: di-dispatch hanya bila job ini `succeeded`; `failed|cancelled` → job ini `cancelled`/`chain_aborted`. */
    afterJobId: uuid("after_job_id").references((): AnyPgColumn => provisionJobs.id, { onDelete: "set null" }),
    /** Grup tampilan "status per langkah". */
    chainId: uuid("chain_id"),
  },
  (t) => [
    index("provision_jobs_status_idx").on(t.status),
    index("provision_jobs_client_idx").on(t.clientId),
    index("provision_jobs_created_idx").on(t.createdAt),
    index("provision_jobs_environment_idx").on(t.environmentId),
    // Satu job aktif per (environment, type) — guard tombol ganda (plan 05 §4.4, AC-J11).
    // Predikat memakai nilai enum LAMA saja (NOT IN final) karena nilai `dispatched` baru ditambah
    // di transaksi migrasi yang sama (PG: nilai enum baru belum boleh dipakai sebelum commit).
    uniqueIndex("provision_jobs_one_active_uq")
      .on(t.environmentId, t.type)
      .where(sql`${t.status} NOT IN ('succeeded', 'failed', 'cancelled')`),
    check(
      "provision_jobs_error_code_valid",
      sql`${t.errorCode} IS NULL OR ${t.errorCode} IN ('rejected_validation', 'rejected_quota', 'disabled', 'blocked_dry_run', 'locked', 'timeout_state_unknown', 'script_exit', 'no_result', 'spool_error', 'result_inconsistent', 'chain_aborted')`,
    ),
    uniqueIndex("provision_jobs_idempotency_key_uq").on(t.idempotencyKey),
    index("provision_jobs_after_job_idx").on(t.afterJobId),
    index("provision_jobs_chain_idx").on(t.chainId),
  ],
);

/**
 * Akses user SSO per tenant-env (plan 05 §7): desired state + cache hasil job `odoo_sso_user`.
 * Sumber kebenaran akses tetap Keycloak (role odoo_access) + Odoo (oauth_uid).
 */
export const tenantUserAccess = pgTable(
  "tenant_user_access",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    environmentId: uuid("environment_id")
      .notNull()
      .references(() => environments.id, { onDelete: "restrict" }),
    /** Email huruf kecil (regex sama dengan scripts/odoo-sso-user.sh). PII — hanya di tabel ini + payload job. */
    email: text("email").notNull(),
    odooLogin: text("odoo_login"),
    isTenantAdmin: boolean("is_tenant_admin").notNull().default(false),
    status: tenantUserStatus("status").notNull().default("pending"),
    /** RESULT kc_user (uuid Keycloak). */
    kcUserId: uuid("kc_user_id"),
    /** RESULT odoo_user (id res.users). */
    odooUserId: integer("odoo_user_id"),
    invitedBy: uuid("invited_by").references(() => users.id, { onDelete: "set null" }),
    lastJobId: uuid("last_job_id").references(() => provisionJobs.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("tenant_user_access_env_email_uq").on(t.environmentId, t.email),
    index("tenant_user_access_email_idx").on(t.email),
    check(
      "tenant_user_access_email_format",
      sql`length(${t.email}) <= 254 AND ${t.email} = lower(${t.email}) AND ${t.email} ~ '^[a-z0-9._%+-]+@([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,63}$'`,
    ),
    check(
      "tenant_user_access_login_format",
      sql`${t.odooLogin} IS NULL OR ${t.odooLogin} ~ '^[A-Za-z0-9._@+][A-Za-z0-9._@+-]{0,253}$'`,
    ),
  ],
);

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    /** Migrasi 0005: ON DELETE RESTRICT (docs/temuan-users-prod-kosong.md). */
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "restrict" }),
    actor: text("actor").notNull(),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    clientId: uuid("client_id").references(() => clients.id, { onDelete: "set null" }),
    result: text("result").notNull().default("success"),
    ip: inet("ip"),
    requestId: text("request_id"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => [
    index("audit_logs_occurred_idx").on(t.occurredAt),
    index("audit_logs_client_idx").on(t.clientId),
    index("audit_logs_action_idx").on(t.action),
  ],
);

/**
 * Penanda email terkirim (ADR 0018 D8, migrasi 0005) — idempotensi pengingat per (subscription, jenis, periode) dan
 * laporan harian. `key` unik = `<kind>:<subscription_id|instance>:<periode|tanggal>`. Klaim `pending` → kirim →
 * `sent`; gagal → `failed` (dicoba ulang tick berikutnya, maks. 3 kali). Tanpa alamat email (PII) di tabel ini.
 */
export const notificationLog = pgTable(
  "notification_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    key: text("key").notNull(),
    kind: text("kind").notNull(),
    subscriptionId: uuid("subscription_id").references(() => subscriptions.id, { onDelete: "restrict" }),
    clientId: uuid("client_id").references(() => clients.id, { onDelete: "restrict" }),
    status: text("status").notNull().default("pending"),
    recipientCount: integer("recipient_count").notNull().default(0),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    createdAt: createdAt(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("notification_log_key_uq").on(t.key),
    index("notification_log_subscription_idx").on(t.subscriptionId),
    check("notification_log_status_valid", sql`${t.status} IN ('pending', 'sent', 'failed')`),
    check("notification_log_key_format", sql`${t.key} ~ '^[a-z0-9_:./-]{3,200}$'`),
  ],
);

// ---------------------------------------------------------------------------
// Mail — PLACEHOLDER (ADR 0005 #16). Hanya tabel; fitur/aksi dirancang di plan mail berikutnya.
// ---------------------------------------------------------------------------
/** Domain mail client: status verifikasi DNS MX/SPF/DKIM/DMARC. Belum dipakai kode aplikasi. */
export const mailDomains = pgTable(
  "mail_domains",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "restrict" }),
    domainId: uuid("domain_id").references(() => domains.id, { onDelete: "set null" }),
    fqdn: text("fqdn").notNull(),
    status: domainStatus("status").notNull().default("pending_dns"),
    dkimSelector: text("dkim_selector"),
    /** Hasil cek DNS terakhir per record (mx/spf/dkim/dmarc) — bentuk final ditentukan plan mail. */
    dnsChecks: jsonb("dns_checks").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("mail_domains_fqdn_uq").on(t.fqdn), index("mail_domains_client_idx").on(t.clientId)],
);

/** Mailbox: kuota, status, override rate-limit. Belum dipakai kode aplikasi. */
export const mailboxes = pgTable(
  "mailboxes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    mailDomainId: uuid("mail_domain_id")
      .notNull()
      .references(() => mailDomains.id, { onDelete: "restrict" }),
    localPart: text("local_part").notNull(),
    quotaMb: integer("quota_mb").notNull().default(2048),
    status: mailboxStatus("status").notNull().default("active"),
    rateLimitPerHour: integer("rate_limit_per_hour"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("mailboxes_address_uq").on(t.mailDomainId, t.localPart),
    check("mailboxes_local_part_format", sql`${t.localPart} ~ '^[a-z0-9._-]{1,64}$'`),
    check("mailboxes_quota_pos", sql`${t.quotaMb} > 0`),
  ],
);
