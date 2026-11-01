/**
 * Layanan Subscriptions & Invoices (ADR 0018 D4/D7, W5). Dipanggil Server Action (web), subscription_tick (worker,
 * lewat helper `*Tx`) dan test. Setiap mutasi: izin (default-deny, lib/roles.ts) → satu transaksi (baris dikunci
 * FOR UPDATE, transisi dari lib/billing.ts yang murni) → audit_logs di transaksi yang sama. Penolakan diaudit
 * `result=rejected` di luar transaksi (yang di-rollback). Tidak ada aksi infra langsung: suspend/resume hanya
 * enqueue job (jobs/tenant-state.ts, outbox di transaksi yang sama).
 */
import { and, eq, inArray, like, ne, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { isUniqueViolation, safeErrorMessage } from "../db/errors";
import { auditLogs, clients, invoices, planQuotas, plans, subscriptions, users } from "../db/schema";
import {
  dateToTimestamp,
  effectivePrice,
  formatInvoiceNumber,
  invoicePrefix,
  isAfter,
  isBillable,
  isPositiveAmount,
  jakartaDate,
  nextInvoiceSeq,
  planGoLive,
  planPayment,
  timestampToDate,
  type IsoDate,
  type SubscriptionStatus,
} from "../lib/billing";
import type { BridgeJobType, Instance } from "../lib/job-contract";
import type { ActionResultCode } from "../lib/job-list-params";
import { computeInvoiceTax, type TaxScheme } from "../lib/bctone-tax";
import { isBctonePlanCode, selfServeStart } from "../lib/bctone-plans";
import type { AiConsent } from "../lib/ai-gateway";
import { writeAiConsentTx } from "../ai/consent";
import { enqueueBctoneConfigTx, type BctoneConfigOutcome } from "../jobs/bctone-config";
import { QUOTA_METRICS, type QuotaMetric } from "../lib/bctone-quota";
import { can, type Permission } from "../lib/roles";
import type { Actor, RequestMeta, SendFn, Tx } from "../jobs/service";
import { TenantStateError, enqueueTenantStateTx, type TenantStateOutcome } from "../jobs/tenant-state";

export interface BillingServiceInput {
  actor: Actor;
  meta: RequestMeta;
  instance: Instance | undefined;
  allowedTypes: readonly BridgeJobType[];
  send: SendFn;
  now?: Date;
}

export type BillingFailure =
  | { reason: "forbidden" }
  | { reason: "not_found" }
  | { reason: "invalid" }
  | { reason: "tenant_inactive" }
  | { reason: "plan_inactive" }
  | { reason: "service_exists" }
  | { reason: "billing_status" }
  | { reason: "future_date" }
  | { reason: "exists" }
  | { reason: "invoice_state" }
  | { reason: "quota"; detail: string }
  | { reason: "duplicate"; detail: string }
  /** QA N8: job suspend/resume kebalikan masih aktif — tandai lunas ditolak, ulangi setelah job selesai. */
  | { reason: "state_busy"; detail: string }
  | { reason: "error"; message: string };

export type BillingOutcome = { ok: true; id: string; jobIds: string[] } | ({ ok: false } & BillingFailure);

class Abort extends Error {
  constructor(readonly failure: BillingFailure) {
    super(failure.reason);
  }
}

/** Dilempar helper `*Tx` (mis. createSubscriptionTx dari onboarding tenant) — pemanggil memetakan ke penolakannya. */
export { Abort as BillingAbort };

/** Bagian input yang dibutuhkan audit (helper transaksi yang dipanggil dari luar layanan ini). */
export type BillingAuditInput = Pick<BillingServiceInput, "actor" | "meta">;

interface AuditTarget {
  action: string;
  targetType: "subscription" | "invoice";
  targetId: string | null;
  clientId: string | null;
}

function actorLabel(a: Actor): string {
  return `user:${a.sub}`;
}

async function auditRejected(db: Db, input: BillingServiceInput, t: AuditTarget, failure: BillingFailure): Promise<void> {
  try {
    await db.insert(auditLogs).values({
      actorUserId: input.actor.userId,
      actor: actorLabel(input.actor),
      action: t.action,
      targetType: t.targetType,
      targetId: t.targetId,
      clientId: t.clientId,
      result: "rejected",
      ip: input.meta.ip,
      requestId: input.meta.requestId,
      metadata: { reason: failure.reason, ...("detail" in failure ? { detail: failure.detail } : {}) },
    });
  } catch {
    // diabaikan: penolakan tetap dikembalikan
  }
}

async function auditOk(tx: Tx, input: BillingAuditInput, t: AuditTarget, metadata: Record<string, unknown>): Promise<void> {
  await tx.insert(auditLogs).values({
    actorUserId: input.actor.userId,
    actor: actorLabel(input.actor),
    action: t.action,
    targetType: t.targetType,
    targetId: t.targetId,
    clientId: t.clientId,
    result: "success",
    ip: input.meta.ip,
    requestId: input.meta.requestId,
    metadata,
  });
}

/** Kerangka: izin → transaksi → penolakan diaudit. `t` boleh dilengkapi body (clientId diketahui setelah baca). */
async function run(
  db: Db,
  input: BillingServiceInput,
  permission: Permission,
  t: AuditTarget,
  body: (tx: Tx, t: AuditTarget) => Promise<{ id: string; jobIds?: string[] }>,
): Promise<BillingOutcome> {
  // QA N2: baris users aktor berstatus disabled (sesi JWT masih hidup ≤ 8 jam) → ditolak seperti tidak berizin.
  if (!can(input.actor.roles, permission) || (await actorDisabled(db, input.actor))) {
    await auditRejected(db, input, t, { reason: "forbidden" });
    return { ok: false, reason: "forbidden" };
  }
  try {
    const r = await db.transaction((tx) => body(tx, t));
    return { ok: true, id: r.id, jobIds: r.jobIds ?? [] };
  } catch (err) {
    if (err instanceof Abort) {
      await auditRejected(db, input, t, err.failure);
      return { ok: false, ...err.failure };
    }
    if (err instanceof TenantStateError) {
      const failure: BillingFailure =
        err.reason === "quota"
          ? { reason: "quota", detail: err.detail }
          : err.reason === "duplicate"
            ? { reason: "duplicate", detail: err.detail }
            : err.reason === "busy"
              ? { reason: "state_busy", detail: err.detail }
              : { reason: "invalid" };
      await auditRejected(db, input, t, failure);
      return { ok: false, ...failure };
    }
    if (isUniqueViolation(err, "invoices_maintenance_period_uq")) {
      await auditRejected(db, input, t, { reason: "exists" });
      return { ok: false, reason: "exists" };
    }
    return { ok: false, reason: "error", message: safeErrorMessage(err) };
  }
}

/** Aktor nonaktif (users.status = disabled) — pola sama dengan jobs/tenants.ts. */
async function actorDisabled(db: Db, actor: Actor): Promise<boolean> {
  if (!actor.userId) return false;
  const row = (await db.select({ status: users.status }).from(users).where(eq(users.id, actor.userId)).limit(1))[0];
  return row?.status === "disabled";
}

function tenantActive(c: { isPlatform: boolean; status: string; terminatedAt: Date | null }): boolean {
  return !c.isPlatform && c.status !== "terminated" && c.terminatedAt === null;
}

// ---------------------------------------------------------------------------
// Helper transaksi (dipakai juga oleh subscription_tick)
// ---------------------------------------------------------------------------
/** Nomor `INV/YYYY/MM/NNNN` berikutnya — advisory lock per bulan; unique index invoices_number_uq sebagai penjaga. */
export async function allocateInvoiceNumber(tx: Tx, issueDate: IsoDate): Promise<string> {
  const prefix = invoicePrefix(issueDate);
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`invoice-seq:${prefix}`}))`);
  const rows = await tx.select({ number: invoices.number }).from(invoices).where(like(invoices.number, `${prefix}%`));
  return formatInvoiceNumber(issueDate, nextInvoiceSeq(rows.map((r) => r.number), prefix));
}

export interface InvoiceDraft {
  clientId: string;
  subscriptionId: string | null;
  kind: "implementation" | "maintenance";
  amount: string;
  currency: string;
  dueAt: IsoDate;
  period: { start: IsoDate; end: IsoDate } | null;
  /** ADR 0019: pajak BCTOne. Tidak diisi = `none` (perilaku lama, tanpa PPN). */
  tax?: { scheme: TaxScheme; withholdPph23: boolean } | undefined;
}

/** Terbitkan invoice di transaksi `tx` (pemanggil sudah mengunci subscription bila ada). Maintenance per periode unik. */
export async function issueInvoiceTx(tx: Tx, draft: InvoiceDraft, now: Date): Promise<{ id: string; number: string } | "exists"> {
  if (draft.kind === "maintenance" && draft.subscriptionId && draft.period) {
    const dup = await tx
      .select({ id: invoices.id })
      .from(invoices)
      .where(
        and(
          eq(invoices.subscriptionId, draft.subscriptionId),
          eq(invoices.kind, "maintenance"),
          eq(invoices.periodStart, draft.period.start),
          ne(invoices.status, "void"),
        ),
      )
      .limit(1);
    if (dup.length > 0) return "exists";
  }
  const number = await allocateInvoiceNumber(tx, jakartaDate(now));
  const tax = draft.tax && draft.tax.scheme !== "none" ? computeInvoiceTax(draft.amount, draft.tax) : null;
  const row = (
    await tx
      .insert(invoices)
      .values({
        number,
        clientId: draft.clientId,
        subscriptionId: draft.subscriptionId,
        kind: draft.kind,
        amount: draft.amount,
        currency: draft.currency,
        status: "unpaid",
        issuedAt: now,
        dueAt: dateToTimestamp(draft.dueAt),
        periodStart: draft.period?.start ?? null,
        periodEnd: draft.period?.end ?? null,
        ...(tax
          ? { taxScheme: tax.scheme, ppnAmount: tax.ppnAmount, pph23Amount: tax.pph23Amount, totalAmount: tax.totalAmount }
          : {}),
      })
      .returning({ id: invoices.id })
  )[0];
  if (!row) throw new Error("insert invoices tanpa id");
  return { id: row.id, number };
}

/** Baris subscription + plan + tenant, terkunci FOR UPDATE (subscription saja). */
export async function lockSubscription(tx: Tx, subscriptionId: string) {
  const row = (
    await tx
      .select({
        id: subscriptions.id,
        clientId: subscriptions.clientId,
        status: subscriptions.status,
        startsAt: subscriptions.currentPeriodStart,
        endsAt: subscriptions.currentPeriodEnd,
        graceUntil: subscriptions.graceUntil,
        goLiveAt: subscriptions.goLiveAt,
        warrantyUntil: subscriptions.warrantyUntil,
        lifecycle: subscriptions.lifecycle,
        suspendedAt: subscriptions.suspendedAt,
        purgeDueAt: subscriptions.purgeDueAt,
        hasPendingProof: sql<boolean>`exists (select 1 from ${invoices} where ${invoices.subscriptionId} = ${subscriptions.id} and ${invoices.status} = 'awaiting_confirmation')`,
        planId: plans.id,
        planCode: plans.code,
        planService: plans.service,
        planPrice: plans.priceAmount,
        planCurrency: plans.currency,
        subPrice: subscriptions.priceAmount,
        subCurrency: subscriptions.priceCurrency,
        periodMonths: plans.billingPeriodMonths,
        slug: clients.slug,
        isPlatform: clients.isPlatform,
        withholdsPph23: clients.withholdsPph23,
      })
      .from(subscriptions)
      .innerJoin(plans, eq(plans.id, subscriptions.planId))
      .innerJoin(clients, eq(clients.id, subscriptions.clientId))
      .where(eq(subscriptions.id, subscriptionId))
      .for("update", { of: subscriptions })
      .limit(1)
  )[0];
  if (!row) return null;
  return {
    ...row,
    status: row.status as SubscriptionStatus,
    /** Harga invoice maintenance otomatis (override langganan → harga plan → null). */
    price: effectivePrice({ subscriptionPrice: row.subPrice, subscriptionCurrency: row.subCurrency, planPrice: row.planPrice, planCurrency: row.planCurrency }),
    /** ADR 0019: tagihan self_serve (BCTOne) dikenai PPN; siklus implementasi tetap tanpa pajak otomatis. */
    tax: row.lifecycle === "self_serve" ? ({ scheme: "ppn_dpp_nilai_lain", withholdPph23: row.withholdsPph23 } as const) : undefined,
    snapshot: {
      status: row.status as SubscriptionStatus,
      warrantyUntil: row.warrantyUntil,
      startsAt: timestampToDate(row.startsAt),
      endsAt: timestampToDate(row.endsAt),
      graceUntil: timestampToDate(row.graceUntil),
      periodMonths: row.periodMonths,
      lifecycle: row.lifecycle,
      suspendedOn: timestampToDate(row.suspendedAt),
      purgeDueOn: row.purgeDueAt,
      hasPendingProof: row.hasPendingProof === true,
    },
  };
}

export type LockedSubscription = NonNullable<Awaited<ReturnType<typeof lockSubscription>>>;

// ---------------------------------------------------------------------------
// Aksi platform-admin
// ---------------------------------------------------------------------------
export interface CreateSubscriptionParams {
  clientId: string;
  planId: string;
  notes?: string | undefined;
  /** Override harga per langganan (superadmin); keduanya diisi atau keduanya kosong. */
  priceAmount?: string | undefined;
  priceCurrency?: string | undefined;
  /** Onboarding tenant: plan wajib layanan ini (mis. `odoo`). */
  requireService?: "odoo" | "insight" | "mail" | "web";
  /** ADR 0019: tanggal mulai langganan self-serve (paket `bctone-*`). Default = hari ini (WIB). */
  startsAt?: IsoDate | undefined;
  /** Waktu acuan nomor/tanggal invoice (test). */
  now?: Date | undefined;
}

/**
 * Buat langganan berstatus `implementation` di transaksi `tx` (dipakai createSubscription dan onboarding tenant —
 * tenant baru + langganan dalam SATU transaksi). Pemanggil sudah memeriksa izin `billing:manage`. Menolak dengan
 * melempar `BillingAbort`.
 */
export async function createSubscriptionTx(tx: Tx, input: BillingAuditInput, p: CreateSubscriptionParams): Promise<{ id: string }> {
  const t: AuditTarget = { action: "subscription.create", targetType: "subscription", targetId: null, clientId: p.clientId };
  const client = (
    await tx
      .select({ id: clients.id, isPlatform: clients.isPlatform, status: clients.status, terminatedAt: clients.terminatedAt })
      .from(clients)
      .where(eq(clients.id, p.clientId))
      .for("update")
      .limit(1)
  )[0];
  if (!client) throw new Abort({ reason: "not_found" });
  if (!tenantActive(client)) throw new Abort({ reason: "tenant_inactive" });
  const plan = (await tx.select().from(plans).where(eq(plans.id, p.planId)).limit(1))[0];
  if (!plan) throw new Abort({ reason: "not_found" });
  if (!plan.isActive || !plan.service) throw new Abort({ reason: "plan_inactive" });
  if (p.requireService && plan.service !== p.requireService) throw new Abort({ reason: "plan_inactive" });
  if ((p.priceAmount === undefined) !== (p.priceCurrency === undefined)) throw new Abort({ reason: "invalid" });
  if (p.priceAmount !== undefined && !isPositiveAmount(p.priceAmount)) throw new Abort({ reason: "invalid" });
  // Satu langganan non-terminated per layanan per tenant (klien terkunci FOR UPDATE di atas → tanpa balapan).
  const dup = await tx
    .select({ id: subscriptions.id })
    .from(subscriptions)
    .innerJoin(plans, eq(plans.id, subscriptions.planId))
    .where(and(eq(subscriptions.clientId, client.id), eq(plans.service, plan.service), ne(subscriptions.status, "terminated")))
    .limit(1);
  if (dup.length > 0) throw new Abort({ reason: "service_exists" });
  if (isBctonePlanCode(plan.code)) return createSelfServeSubscriptionTx(tx, input, p, client, plan, t);
  const row = (
    await tx
      .insert(subscriptions)
      .values({
        clientId: client.id,
        planId: plan.id,
        status: "implementation",
        notes: p.notes ?? null,
        priceAmount: p.priceAmount ?? null,
        priceCurrency: p.priceAmount !== undefined ? (p.priceCurrency ?? null) : null,
      })
      .returning({ id: subscriptions.id })
  )[0];
  if (!row) throw new Error("insert subscriptions tanpa id");
  await auditOk(tx, input, { ...t, targetId: row.id }, {
    to: "implementation",
    plan_code: plan.code,
    service: plan.service,
    ...(p.priceAmount !== undefined ? { price_amount: p.priceAmount, price_currency: p.priceCurrency } : {}),
  });
  return { id: row.id };
}

/**
 * ADR 0019 + D-1: langganan paket BCTOne dibuat dari form CP — lifecycle `self_serve`, langsung `active` dengan periode
 * berjalan; paket berbayar langsung diterbitkan invoice pertama (PPN, PPh 23 bila klien memotong). Plan tanpa harga
 * (Free) tanpa invoice.
 */
async function createSelfServeSubscriptionTx(
  tx: Tx,
  input: BillingAuditInput,
  p: CreateSubscriptionParams,
  client: { id: string },
  plan: typeof plans.$inferSelect,
  t: AuditTarget,
): Promise<{ id: string }> {
  const now = p.now ?? new Date();
  const start = p.startsAt ?? jakartaDate(now);
  const period = selfServeStart(start, plan.billingPeriodMonths);
  const row = (
    await tx
      .insert(subscriptions)
      .values({
        clientId: client.id,
        planId: plan.id,
        status: "active",
        lifecycle: "self_serve",
        currentPeriodStart: dateToTimestamp(period.startsAt),
        currentPeriodEnd: dateToTimestamp(period.endsAt),
        notes: p.notes ?? null,
        priceAmount: p.priceAmount ?? null,
        priceCurrency: p.priceAmount !== undefined ? (p.priceCurrency ?? null) : null,
      })
      .returning({ id: subscriptions.id })
  )[0];
  if (!row) throw new Error("insert subscriptions tanpa id");
  const price = effectivePrice({
    subscriptionPrice: p.priceAmount ?? null,
    subscriptionCurrency: p.priceAmount !== undefined ? (p.priceCurrency ?? null) : null,
    planPrice: plan.priceAmount,
    planCurrency: plan.currency,
  });
  let invoice: string = "free";
  if (price) {
    const withhold = (await tx.select({ w: clients.withholdsPph23 }).from(clients).where(eq(clients.id, client.id)).limit(1))[0]?.w === true;
    const r = await issueInvoiceTx(
      tx,
      {
        clientId: client.id,
        subscriptionId: row.id,
        kind: "maintenance",
        amount: price.amount,
        currency: price.currency,
        dueAt: period.startsAt,
        period: { start: period.startsAt, end: period.endsAt },
        tax: { scheme: "ppn_dpp_nilai_lain", withholdPph23: withhold },
      },
      now,
    );
    invoice = r === "exists" ? "exists" : r.number;
  }
  await auditOk(tx, input, { ...t, targetId: row.id }, {
    to: "active",
    lifecycle: "self_serve",
    plan_code: plan.code,
    service: plan.service,
    starts_at: period.startsAt,
    ends_at: period.endsAt,
    invoice,
    ...(p.priceAmount !== undefined ? { price_amount: p.priceAmount, price_currency: p.priceCurrency } : {}),
  });
  return { id: row.id };
}

export async function createSubscription(db: Db, input: BillingServiceInput, p: CreateSubscriptionParams): Promise<BillingOutcome> {
  return run(db, input, "billing:manage", { action: "subscription.create", targetType: "subscription", targetId: null, clientId: p.clientId }, async (tx) => {
    const r = await createSubscriptionTx(tx, input, p);
    // ADR 0019: paket BCTOne pada tenant yang DB-nya sudah ada → konfigurasi tenant (agen + kuota) di transaksi yang sama.
    const plan = (await tx.select({ id: plans.id, code: plans.code }).from(plans).where(eq(plans.id, p.planId)).limit(1))[0];
    if (plan && isBctonePlanCode(plan.code)) {
      const c = (await tx.select({ id: clients.id, slug: clients.slug }).from(clients).where(eq(clients.id, p.clientId)).limit(1))[0]!;
      const o = await enqueueBctoneConfigTx(tx, input.send, {
        instance: input.instance,
        allowedTypes: input.allowedTypes,
        client: c,
        plan,
        enabled: true,
        actorLabel: actorLabel(input.actor),
        actorUserId: input.actor.userId,
        meta: input.meta,
        context: { reason: "subscription_create", subscription_id: r.id },
        now: input.now ?? new Date(),
      });
      return { id: r.id, jobIds: o.kind === "enqueued" ? o.jobIds : [] };
    }
    return r;
  });
}

/**
 * Ubah/hapus override harga langganan (superadmin, `billing:manage`). `priceAmount` null = kembali ke harga plan.
 * Berlaku untuk invoice maintenance BERIKUTNYA (invoice yang sudah terbit tidak diubah). Langganan terminated ditolak.
 */
export async function setSubscriptionPrice(
  db: Db,
  input: BillingServiceInput,
  p: { subscriptionId: string; priceAmount: string | null; priceCurrency: string },
): Promise<BillingOutcome> {
  return run(db, input, "billing:manage", { action: "subscription.price", targetType: "subscription", targetId: p.subscriptionId, clientId: null }, async (tx, t) => {
    const s = await lockSubscription(tx, p.subscriptionId);
    if (!s) throw new Abort({ reason: "not_found" });
    t.clientId = s.clientId;
    if (s.status === "terminated") throw new Abort({ reason: "billing_status" });
    if (p.priceAmount !== null && !isPositiveAmount(p.priceAmount)) throw new Abort({ reason: "invalid" });
    const next = p.priceAmount === null ? { priceAmount: null, priceCurrency: null } : { priceAmount: p.priceAmount, priceCurrency: p.priceCurrency };
    await tx.update(subscriptions).set({ ...next, updatedAt: sql`now()` }).where(eq(subscriptions.id, s.id));
    await auditOk(tx, input, t, {
      from: { price_amount: s.subPrice, price_currency: s.subCurrency },
      to: { price_amount: next.priceAmount, price_currency: next.priceCurrency },
      plan_price: s.planPrice,
    });
    return { id: s.id };
  });
}

export async function goLiveSubscription(
  db: Db,
  input: BillingServiceInput,
  p: { subscriptionId: string; goLiveAt: IsoDate },
): Promise<BillingOutcome> {
  const now = input.now ?? new Date();
  return run(db, input, "billing:manage", { action: "subscription.go_live", targetType: "subscription", targetId: p.subscriptionId, clientId: null }, async (tx, t) => {
    const s = await lockSubscription(tx, p.subscriptionId);
    if (!s) throw new Abort({ reason: "not_found" });
    t.clientId = s.clientId;
    const g = planGoLive(s.snapshot, p.goLiveAt, jakartaDate(now));
    if (!g.ok) throw new Abort({ reason: g.reason });
    await tx
      .update(subscriptions)
      .set({ status: "warranty", goLiveAt: p.goLiveAt, warrantyUntil: g.warrantyUntil, updatedAt: sql`now()` })
      .where(eq(subscriptions.id, s.id));
    await auditOk(tx, input, t, { from: s.status, to: "warranty", go_live_at: p.goLiveAt, warranty_until: g.warrantyUntil });
    return { id: s.id };
  });
}

export async function terminateSubscription(db: Db, input: BillingServiceInput, p: { subscriptionId: string }): Promise<BillingOutcome> {
  return run(db, input, "billing:manage", { action: "subscription.terminate", targetType: "subscription", targetId: p.subscriptionId, clientId: null }, async (tx, t) => {
    const s = await lockSubscription(tx, p.subscriptionId);
    if (!s) throw new Abort({ reason: "not_found" });
    t.clientId = s.clientId;
    if (s.status === "terminated") throw new Abort({ reason: "billing_status" });
    await tx
      .update(subscriptions)
      .set({ status: "terminated", terminatedAt: sql`now()`, updatedAt: sql`now()` })
      .where(eq(subscriptions.id, s.id));
    // Arsip/hapus data = fase lain (ADR 0018 D4). Route tidak diubah di sini.
    await auditOk(tx, input, t, { from: s.status, to: "terminated" });
    return { id: s.id };
  });
}

export async function issueInvoice(
  db: Db,
  input: BillingServiceInput,
  p: { clientId: string; subscriptionId?: string | undefined; kind: "implementation" | "maintenance"; amount: string; dueAt: IsoDate },
): Promise<BillingOutcome> {
  const now = input.now ?? new Date();
  return run(db, input, "billing:manage", { action: "invoice.issue", targetType: "invoice", targetId: null, clientId: p.clientId }, async (tx, t) => {
    if (!isPositiveAmount(p.amount)) throw new Abort({ reason: "invalid" });
    const client = (
      await tx
        .select({ id: clients.id, isPlatform: clients.isPlatform, status: clients.status, terminatedAt: clients.terminatedAt })
        .from(clients)
        .where(eq(clients.id, p.clientId))
        .limit(1)
    )[0];
    if (!client) throw new Abort({ reason: "not_found" });
    if (!tenantActive(client)) throw new Abort({ reason: "tenant_inactive" });
    const s = p.subscriptionId ? await lockSubscription(tx, p.subscriptionId) : null;
    // Subscription harus milik tenant yang sama (id dari form tidak dipercaya).
    if (p.subscriptionId && (!s || s.clientId !== client.id)) throw new Abort({ reason: "not_found" });
    let period: InvoiceDraft["period"] = null;
    if (p.kind === "maintenance") {
      if (!s) throw new Abort({ reason: "invalid" });
      if (!isBillable(s.status) || !s.snapshot.startsAt || !s.snapshot.endsAt) throw new Abort({ reason: "billing_status" });
      period = { start: s.snapshot.startsAt, end: s.snapshot.endsAt };
    }
    const r = await issueInvoiceTx(
      tx,
      { clientId: client.id, subscriptionId: s?.id ?? null, kind: p.kind, amount: p.amount, currency: s ? (s.price?.currency ?? s.planCurrency) : "IDR", dueAt: p.dueAt, period },
      now,
    );
    if (r === "exists") throw new Abort({ reason: "exists" });
    await auditOk(tx, input, { ...t, targetId: r.id }, {
      number: r.number,
      kind: p.kind,
      amount: p.amount,
      subscription_id: s?.id ?? null,
      period_start: period?.start ?? null,
      period_end: period?.end ?? null,
      due_at: p.dueAt,
    });
    return { id: r.id };
  });
}

async function lockInvoice(tx: Tx, invoiceId: string) {
  return (
    await tx
      .select({
        id: invoices.id,
        number: invoices.number,
        clientId: invoices.clientId,
        subscriptionId: invoices.subscriptionId,
        kind: invoices.kind,
        status: invoices.status,
        issuedAt: invoices.issuedAt,
      })
      .from(invoices)
      .where(eq(invoices.id, invoiceId))
      .for("update")
      .limit(1)
  )[0];
}

const OPEN_INVOICE = ["unpaid", "awaiting_confirmation"] as const;

export async function voidInvoice(db: Db, input: BillingServiceInput, p: { invoiceId: string; reason: string }): Promise<BillingOutcome> {
  return run(db, input, "billing:manage", { action: "invoice.void", targetType: "invoice", targetId: p.invoiceId, clientId: null }, async (tx, t) => {
    const inv = await lockInvoice(tx, p.invoiceId);
    if (!inv) throw new Abort({ reason: "not_found" });
    t.clientId = inv.clientId;
    if (!(OPEN_INVOICE as readonly string[]).includes(inv.status)) throw new Abort({ reason: "invoice_state" });
    await tx.update(invoices).set({ status: "void", voidReason: p.reason, updatedAt: sql`now()` }).where(eq(invoices.id, inv.id));
    await auditOk(tx, input, t, { number: inv.number, kind: inv.kind, from: inv.status, reason: p.reason });
    return { id: inv.id };
  });
}

/**
 * Tandai lunas (`invoices:confirm` = superadmin+ops): tanggal bayar, referensi pembayaran, referensi bukti (teks, tanpa
 * upload Fase 1). Invoice maintenance → perpanjang periode (planPayment), terbitkan invoice periode berikutnya bila harga
 * plan ada, dan bila sebelumnya suspended + layanan Odoo → enqueue tenant_resume (transaksi sama).
 */
export async function markInvoicePaid(
  db: Db,
  input: BillingServiceInput,
  p: { invoiceId: string; paidAt: IsoDate; paymentReference: string; proofReference: string },
): Promise<BillingOutcome> {
  const now = input.now ?? new Date();
  return run(db, input, "invoices:confirm", { action: "invoice.paid", targetType: "invoice", targetId: p.invoiceId, clientId: null }, async (tx, t) => {
    const inv = await lockInvoice(tx, p.invoiceId);
    if (!inv) throw new Abort({ reason: "not_found" });
    t.clientId = inv.clientId;
    if (!(OPEN_INVOICE as readonly string[]).includes(inv.status)) throw new Abort({ reason: "invoice_state" });
    if (isAfter(p.paidAt, jakartaDate(now))) throw new Abort({ reason: "future_date" });
    await tx
      .update(invoices)
      .set({
        status: "paid",
        paidAt: dateToTimestamp(p.paidAt),
        confirmedAt: now,
        confirmedBy: input.actor.userId,
        paymentReference: p.paymentReference,
        proofReference: p.proofReference,
        updatedAt: sql`now()`,
      })
      .where(eq(invoices.id, inv.id));

    const s = inv.subscriptionId ? await lockSubscription(tx, inv.subscriptionId) : null;
    const plan = planPayment(s?.snapshot ?? null, inv.kind);
    const md: Record<string, unknown> = { number: inv.number, kind: inv.kind, paid_at: p.paidAt, has_proof: true };
    let jobIds: string[] = [];
    if (plan.kind === "extend" && s) {
      await tx
        .update(subscriptions)
        .set({
          status: "active",
          currentPeriodStart: dateToTimestamp(plan.startsAt),
          currentPeriodEnd: dateToTimestamp(plan.endsAt),
          graceUntil: null,
          suspendedAt: null,
          // ADR 0019: lunas membatalkan penanda purge self_serve.
          purgeDueAt: null,
          updatedAt: sql`now()`,
        })
        .where(eq(subscriptions.id, s.id));
      md.subscription_id = s.id;
      md.transition = { from: plan.from, to: "active", starts_at: plan.startsAt, ends_at: plan.endsAt };
      if (s.price !== null) {
        const next = await issueInvoiceTx(
          tx,
          {
            clientId: s.clientId,
            subscriptionId: s.id,
            kind: "maintenance",
            amount: s.price.amount,
            currency: s.price.currency,
            dueAt: plan.nextInvoicePeriod.end,
            period: plan.nextInvoicePeriod,
            tax: s.tax,
          },
          now,
        );
        md.next_invoice = next === "exists" ? "exists" : next.number;
        md.price_source = s.price.source;
      } else {
        md.next_invoice = "price_missing";
      }
      if (plan.resume) {
        const r: TenantStateOutcome =
          s.planService === "odoo"
            ? await enqueueTenantStateTx(tx, input.send, {
                instance: input.instance,
                allowedTypes: input.allowedTypes,
                client: { id: s.clientId, slug: s.slug },
                type: "tenant_resume",
                actorLabel: actorLabel(input.actor),
                actorUserId: input.actor.userId,
                meta: input.meta,
                context: { reason: "invoice_paid", subscription_id: s.id, invoice_id: inv.id },
                now,
              })
            : { kind: "skipped", reason: "no_environment" };
        md.resume = r.kind === "enqueued" ? { job_ids: r.jobIds, reused: r.reused } : { skipped: s.planService === "odoo" ? r.reason : "service_not_odoo" };
        if (r.kind === "enqueued") jobIds = r.jobIds;
      }
    }
    await auditOk(tx, input, t, md);
    return { id: inv.id, jobIds };
  });
}

// ---------------------------------------------------------------------------
// D-1 (owner 2026-11-01): kelola paket, kuota, dan pajak klien lewat form CP (superadmin, `billing:manage`)
// ---------------------------------------------------------------------------
/** Plan sebagai target audit memakai targetType `subscription` = domain billing; id plan di metadata. */
export async function updatePlan(
  db: Db,
  input: BillingServiceInput,
  p: { planId: string; priceAmount: string | null; isActive: boolean; limits: Partial<Record<QuotaMetric, number | null>> },
): Promise<BillingOutcome> {
  return run(db, input, "billing:manage", { action: "plan.update", targetType: "subscription", targetId: null, clientId: null }, async (tx) => {
    const plan = (await tx.select().from(plans).where(eq(plans.id, p.planId)).for("update").limit(1))[0];
    if (!plan) throw new Abort({ reason: "not_found" });
    if (p.priceAmount !== null && !isPositiveAmount(p.priceAmount)) throw new Abort({ reason: "invalid" });
    const changes: Record<string, unknown> = {};
    if ((plan.priceAmount ?? null) !== p.priceAmount) changes.price_amount = { from: plan.priceAmount, to: p.priceAmount };
    if (plan.isActive !== p.isActive) changes.is_active = { from: plan.isActive, to: p.isActive };
    if (Object.keys(changes).length > 0) {
      await tx.update(plans).set({ priceAmount: p.priceAmount, isActive: p.isActive, updatedAt: sql`now()` }).where(eq(plans.id, plan.id));
    }
    const cur = await tx.select({ metric: planQuotas.metric, limit: planQuotas.limitValue }).from(planQuotas).where(eq(planQuotas.planId, plan.id));
    const curMap = new Map(cur.map((r) => [r.metric, r.limit]));
    for (const m of QUOTA_METRICS) {
      if (!(m in p.limits)) continue;
      const want = p.limits[m] ?? null;
      const have = curMap.get(m) ?? null;
      if (want === have) continue;
      changes[`limit.${m}`] = { from: have, to: want };
      if (want === null) {
        await tx.delete(planQuotas).where(and(eq(planQuotas.planId, plan.id), eq(planQuotas.metric, m)));
      } else {
        await tx
          .insert(planQuotas)
          .values({ planId: plan.id, metric: m, limitValue: want })
          .onConflictDoUpdate({ target: [planQuotas.planId, planQuotas.metric], set: { limitValue: want, updatedAt: sql`now()` } });
      }
    }
    // ADR 0019: kuota berubah → konfigurasi ulang setiap tenant self-serve aktif di paket ini (job per tenant).
    const jobIds: string[] = [];
    const reconfig: Record<string, string> = {};
    if (isBctonePlanCode(plan.code) && Object.keys(changes).some((k) => k.startsWith("limit."))) {
      const subs = await tx
        .select({ clientId: clients.id, slug: clients.slug })
        .from(subscriptions)
        .innerJoin(clients, eq(clients.id, subscriptions.clientId))
        .where(and(eq(subscriptions.planId, plan.id), eq(subscriptions.lifecycle, "self_serve"), inArray(subscriptions.status, ["active", "past_due"])));
      for (const s of subs) {
        const o: BctoneConfigOutcome = await enqueueBctoneConfigTx(tx, input.send, {
          instance: input.instance,
          allowedTypes: input.allowedTypes,
          client: { id: s.clientId, slug: s.slug },
          plan: { id: plan.id, code: plan.code },
          enabled: true,
          actorLabel: actorLabel(input.actor),
          actorUserId: input.actor.userId,
          meta: input.meta,
          context: { reason: "plan_update" },
          now: input.now ?? new Date(),
        });
        reconfig[s.slug] = o.kind === "enqueued" ? `jobs=${o.jobIds.length}${o.busy ? ",busy" : ""}` : `skipped:${o.reason}`;
        if (o.kind === "enqueued") jobIds.push(...o.jobIds);
      }
    }
    await auditOk(tx, input, { action: "plan.update", targetType: "subscription", targetId: null, clientId: null }, {
      plan_id: plan.id,
      plan_code: plan.code,
      changes,
      ...(Object.keys(reconfig).length > 0 ? { reconfig } : {}),
    });
    return { id: plan.id, jobIds };
  });
}

/** Penanda klien memotong PPh 23 (BR-17) — berlaku untuk invoice BCTOne berikutnya. */
export async function setClientWithholding(
  db: Db,
  input: BillingServiceInput,
  p: { clientId: string; withholdsPph23: boolean },
): Promise<BillingOutcome> {
  return run(db, input, "billing:manage", { action: "client.tax", targetType: "subscription", targetId: null, clientId: p.clientId }, async (tx, t) => {
    const c = (await tx.select({ id: clients.id, w: clients.withholdsPph23, isPlatform: clients.isPlatform }).from(clients).where(eq(clients.id, p.clientId)).for("update").limit(1))[0];
    if (!c) throw new Abort({ reason: "not_found" });
    if (c.isPlatform) throw new Abort({ reason: "invalid" });
    if (c.w !== p.withholdsPph23) {
      await tx.update(clients).set({ withholdsPph23: p.withholdsPph23, updatedAt: sql`now()` }).where(eq(clients.id, c.id));
    }
    await auditOk(tx, input, t, { withholds_pph23: { from: c.w, to: p.withholdsPph23 } });
    return { id: c.id };
  });
}

/**
 * BCTOne consent AI (BR-05/06/07): dicatat append-only hash-chain + cache clients.ai_consent, satu transaksi dengan audit.
 * Diserialkan dengan advisory lock rantai global (prev_hash deterministik).
 */
export async function setClientAiConsent(db: Db, input: BillingServiceInput, p: { clientId: string; consent: AiConsent }): Promise<BillingOutcome> {
  return run(db, input, "billing:manage", { action: "ai.consent", targetType: "subscription", targetId: null, clientId: p.clientId }, async (tx, t) => {
    const c = (await tx.select({ id: clients.id, cur: clients.aiConsent, isPlatform: clients.isPlatform }).from(clients).where(eq(clients.id, p.clientId)).for("update").limit(1))[0];
    if (!c) throw new Abort({ reason: "not_found" });
    if (c.isPlatform) throw new Abort({ reason: "invalid" });
    const hash = await writeAiConsentTx(tx, c.id, p.consent, actorLabel(input.actor), input.now ?? new Date());
    await auditOk(tx, input, t, { consent: { from: c.cur, to: p.consent }, hash });
    return { id: c.id };
  });
}

/** Pesan aman untuk log pemanggil (SQLSTATE/constraint saja). */
export function billingLogMessage(o: BillingOutcome): string | null {
  return !o.ok && o.reason === "error" ? o.message : null;
}

/** Kode `?r=` (whitelist ACTION_RESULT_CODES) — murni, diuji unit. */
export function billingOutcomeCode(o: BillingOutcome): ActionResultCode {
  if (o.ok) return o.jobIds.length > 0 ? "queued" : "created";
  return o.reason;
}

