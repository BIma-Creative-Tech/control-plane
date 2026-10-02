/**
 * `subscription_tick` harian (ADR 0018 D3/D4/D5/D8) — dijalankan worker (pg-boss schedule 00:15 Asia/Jakarta,
 * worker/billing.ts). Hanya transisi DB + enqueue job + email; tidak ada aksi infra langsung.
 *
 * 1. Transisi per subscription (satu transaksi per baris, FOR UPDATE, rencana dari lib/billing.ts planTransitions):
 *    warranty → active (+ invoice maintenance pertama bila harga plan ada), active → past_due, past_due → suspended
 *    (+ tenant_suspend per environment instance ini, layanan Odoo saja; outbox di transaksi yang sama — gagal enqueue
 *    = transisi di-rollback dan dicoba tick berikutnya).
 * 2. Pengingat email idempoten per (subscription, jenis, periode) lewat notification_log.
 * 3. Cek tenant-admin: tenant non-platform aktif tanpa client_admin invited/active → audit harian; email ke billing HANYA
 *    bila himpunan tenant itu berubah dibanding notifikasi terakhir (sidik di kunci notification_log).
 */
import { and, desc, eq, inArray, isNotNull, isNull, lt, ne, or, sql } from "drizzle-orm";
import type { Logger } from "pino";
import type { Db } from "../db/client";
import { safeErrorMessage } from "../db/errors";
import { auditLogs, clients, invoices, notificationLog, plans, subscriptions, users } from "../db/schema";
import {
  adminCheckKey,
  adminNotifyDecision,
  adminSetFingerprint,
  composeAdminReport,
  composeReminder,
  dateToTimestamp,
  dueReminder,
  fingerprintFromAdminKey,
  planTransitions,
  reminderKey,
  tenantsWithoutAdmin,
  timestampToDate,
  type IsoDate,
  type SubscriptionStatus,
  type Transition,
} from "../lib/billing";
import type { BridgeJobType, Instance } from "../lib/job-contract";
import type { SendFn, Tx } from "../jobs/service";
import { TenantStateError, enqueueTenantStateTx, type TenantStateOutcome } from "../jobs/tenant-state";
import { mailErrorCode, type Mailer } from "./mailer";
import { issueInvoiceTx, lockSubscription, type LockedSubscription } from "./service";

export const TICK_ACTOR = "system:subscription-tick";
const MAX_SEND_ATTEMPTS = 3;

export interface TickDeps {
  db: Db;
  send: SendFn;
  instance: Instance | undefined;
  allowedTypes: readonly BridgeJobType[];
  logger: Pick<Logger, "info" | "warn" | "error">;
  /** null = SMTP tidak dikonfigurasi (pengingat dilewati, tanpa penanda). */
  mailer: Mailer | null;
  billingEmail: string;
  now: Date;
  /** Tanggal bisnis WIB (lib/billing.ts tickToday — TICK_NOW hanya staging). */
  today: IsoDate;
}

export interface TickReport {
  today: IsoDate;
  transitions: number;
  suspendJobs: number;
  invoicesIssued: number;
  anomalies: number;
  errors: number;
  /** Transisi ditunda karena job suspend/resume kebalikan masih aktif (QA N8). */
  deferred: number;
  reminders: { sent: number; skipped: number; failed: number };
  tenantsWithoutAdmin: number;
  /** Keputusan email cek tenant-admin hari ini (`skipped` = SMTP nonaktif). */
  adminCheck: "email" | "mark" | "none" | "skipped";
}

async function audit(
  db: Db | Tx,
  v: { action: string; targetType: string; targetId: string | null; clientId: string | null; result: string; metadata: Record<string, unknown> },
) {
  await db.insert(auditLogs).values({ actor: TICK_ACTOR, ...v });
}

/** Terapkan satu transisi di transaksi `tx` (subscription sudah dikunci). */
async function applyTransition(d: TickDeps, tx: Tx, s: LockedSubscription, t: Transition, report: TickReport): Promise<void> {
  const md: Record<string, unknown> = { from: t.from, to: t.to, today: d.today };
  switch (t.to) {
    case "active": {
      await tx
        .update(subscriptions)
        .set({
          status: "active",
          currentPeriodStart: dateToTimestamp(t.startsAt),
          currentPeriodEnd: dateToTimestamp(t.endsAt),
          graceUntil: null,
          updatedAt: sql`now()`,
        })
        .where(eq(subscriptions.id, s.id));
      md.starts_at = t.startsAt;
      md.ends_at = t.endsAt;
      if (s.price === null) {
        // Harga langganan (override) DAN harga plan belum ditetapkan (ADR 0018 D7) — dilewati, dicatat di audit
        // transisi; billing menerbitkan manual di /invoices.
        md.invoice = "price_missing";
      } else {
        md.price_source = s.price.source;
        const r = await issueInvoiceTx(
          tx,
          {
            clientId: s.clientId,
            subscriptionId: s.id,
            kind: "maintenance",
            amount: s.price.amount,
            currency: s.price.currency,
            dueAt: t.invoicePeriod.end,
            period: t.invoicePeriod,
          },
          d.now,
        );
        md.invoice = r === "exists" ? "exists" : r.number;
        if (r !== "exists") report.invoicesIssued++;
      }
      break;
    }
    case "past_due":
      await tx
        .update(subscriptions)
        .set({ status: "past_due", graceUntil: dateToTimestamp(t.graceUntil), updatedAt: sql`now()` })
        .where(eq(subscriptions.id, s.id));
      md.grace_until = t.graceUntil;
      break;
    case "suspended": {
      await tx.update(subscriptions).set({ status: "suspended", suspendedAt: d.now, updatedAt: sql`now()` }).where(eq(subscriptions.id, s.id));
      // ADR 0018 D6: hanya route Odoo yang disuspend (mail Fase 4, web tetap tayang). Tenant platform tidak pernah.
      const r: TenantStateOutcome =
        s.planService === "odoo" && !s.isPlatform
          ? await enqueueTenantStateTx(tx, d.send, {
              instance: d.instance,
              allowedTypes: d.allowedTypes,
              client: { id: s.clientId, slug: s.slug },
              type: "tenant_suspend",
              actorLabel: TICK_ACTOR,
              actorUserId: null,
              meta: { ip: null, requestId: null },
              context: { reason: "subscription_suspended", subscription_id: s.id },
              now: d.now,
            })
          : { kind: "skipped", reason: "no_environment" };
      if (r.kind === "enqueued") {
        md.suspend_jobs = r.jobIds;
        report.suspendJobs += r.jobIds.length - r.reused;
      } else {
        md.suspend_skipped = s.planService === "odoo" ? r.reason : "service_not_odoo";
      }
      break;
    }
  }
  await audit(tx, { action: "subscription.transition", targetType: "subscription", targetId: s.id, clientId: s.clientId, result: "success", metadata: md });
  report.transitions++;
}

async function processTransitions(d: TickDeps, report: TickReport): Promise<void> {
  // QA N8: tenant terminated dilewati (arsip = fase lain; tidak ada transisi/suspend untuknya).
  const candidates = await d.db
    .select({ id: subscriptions.id })
    .from(subscriptions)
    .innerJoin(clients, eq(clients.id, subscriptions.clientId))
    .where(and(inArray(subscriptions.status, ["warranty", "active", "past_due"]), ne(clients.status, "terminated"), isNull(clients.terminatedAt)))
    .orderBy(subscriptions.createdAt);
  for (const c of candidates) {
    try {
      await d.db.transaction(async (tx) => {
        const s = await lockSubscription(tx, c.id);
        if (!s) return;
        const plan = planTransitions(s.snapshot, d.today);
        if (plan.anomaly) {
          report.anomalies++;
          await audit(tx, {
            action: "subscription.tick_anomaly",
            targetType: "subscription",
            targetId: s.id,
            clientId: s.clientId,
            result: "failure",
            metadata: { anomaly: plan.anomaly, status: s.status, today: d.today },
          });
        }
        for (const t of plan.transitions) await applyTransition(d, tx, s, t, report);
      });
    } catch (err) {
      // QA N8: job kebalikan (resume ↔ suspend) masih aktif → transisi ditunda (di-rollback), dicoba tick berikutnya.
      if (err instanceof TenantStateError && err.reason === "busy") {
        report.deferred++;
        try {
          await audit(d.db, {
            action: "subscription.tick_deferred",
            targetType: "subscription",
            targetId: c.id,
            clientId: null,
            result: "failure",
            metadata: { reason: "state_busy", opposite_job_id: err.detail, today: d.today },
          });
        } catch {
          // diabaikan
        }
        continue;
      }
      report.errors++;
      const msg = safeErrorMessage(err);
      d.logger.error({ subscriptionId: c.id, err: msg }, "subscription_tick: transisi gagal (di-rollback, dicoba tick berikutnya)");
      try {
        await audit(d.db, {
          action: "subscription.tick_error",
          targetType: "subscription",
          targetId: c.id,
          clientId: null,
          result: "failure",
          metadata: { error: msg, today: d.today },
        });
      } catch {
        // diabaikan
      }
    }
  }
}

type SendResult = "sent" | "skipped" | "failed";

/**
 * Kirim paling banyak sekali per `key`: klaim baris `pending` → kirim → `sent`; gagal → `failed` (dicoba lagi tick
 * berikutnya, maks. 3 percobaan). Baris `pending` (proses mati di tengah kirim) TIDAK dikirim ulang — lebih baik satu
 * pengingat terlewat daripada ganda.
 */
export async function sendOnce(
  d: Pick<TickDeps, "db" | "mailer" | "now" | "logger">,
  n: { key: string; kind: string; subscriptionId: string | null; clientId: string | null; to: string[]; cc: string[]; subject: string; text: string },
): Promise<SendResult> {
  if (!d.mailer) return "skipped";
  let claimed = (
    await d.db
      .insert(notificationLog)
      .values({ key: n.key, kind: n.kind, subscriptionId: n.subscriptionId, clientId: n.clientId, status: "pending", attempts: 1 })
      .onConflictDoNothing({ target: notificationLog.key })
      .returning({ id: notificationLog.id })
  )[0];
  if (!claimed) {
    claimed = (
      await d.db
        .update(notificationLog)
        .set({ status: "pending", attempts: sql`${notificationLog.attempts} + 1` })
        .where(and(eq(notificationLog.key, n.key), eq(notificationLog.status, "failed"), lt(notificationLog.attempts, MAX_SEND_ATTEMPTS)))
        .returning({ id: notificationLog.id })
    )[0];
    if (!claimed) return "skipped";
  }
  try {
    await d.mailer.send({ to: n.to, cc: n.cc, subject: n.subject, text: n.text });
    await d.db
      .update(notificationLog)
      .set({ status: "sent", sentAt: d.now, recipientCount: n.to.length + n.cc.length, lastError: null })
      .where(eq(notificationLog.id, claimed.id));
    return "sent";
  } catch (err) {
    const code = mailErrorCode(err);
    d.logger.warn({ key: n.key, code }, "email gagal dikirim");
    await d.db.update(notificationLog).set({ status: "failed", lastError: code }).where(eq(notificationLog.id, claimed.id));
    return "failed";
  }
}

async function tenantAdminEmails(db: Db, clientId: string): Promise<string[]> {
  const rows = await db
    .select({ email: users.email })
    .from(users)
    .where(and(eq(users.clientId, clientId), eq(users.role, "client_admin"), inArray(users.status, ["invited", "active"]), isNotNull(users.email)));
  return [...new Set(rows.map((r) => r.email).filter((e): e is string => typeof e === "string"))];
}

async function processReminders(d: TickDeps, report: TickReport): Promise<void> {
  if (!d.mailer) return;
  const rows = await d.db
    .select({
      id: subscriptions.id,
      clientId: subscriptions.clientId,
      status: subscriptions.status,
      warrantyUntil: subscriptions.warrantyUntil,
      startsAt: subscriptions.currentPeriodStart,
      endsAt: subscriptions.currentPeriodEnd,
      graceUntil: subscriptions.graceUntil,
      periodMonths: plans.billingPeriodMonths,
      planName: plans.name,
      tenantName: clients.name,
      slug: clients.slug,
    })
    .from(subscriptions)
    .innerJoin(plans, eq(plans.id, subscriptions.planId))
    .innerJoin(clients, eq(clients.id, subscriptions.clientId))
    .where(
      and(
        inArray(subscriptions.status, ["warranty", "active", "past_due", "suspended"]),
        eq(clients.isPlatform, false),
        ne(clients.status, "terminated"),
        isNull(clients.terminatedAt),
      ),
    );
  for (const r of rows) {
    try {
      const snap = {
        status: r.status as SubscriptionStatus,
        warrantyUntil: r.warrantyUntil,
        startsAt: timestampToDate(r.startsAt),
        endsAt: timestampToDate(r.endsAt),
        graceUntil: timestampToDate(r.graceUntil),
        periodMonths: r.periodMonths,
      };
      const due = dueReminder(snap, d.today);
      if (!due) continue;
      const inv = (
        await d.db
          .select({ number: invoices.number, amount: invoices.amount, currency: invoices.currency })
          .from(invoices)
          .where(and(eq(invoices.subscriptionId, r.id), eq(invoices.kind, "maintenance"), or(eq(invoices.status, "unpaid"), eq(invoices.status, "awaiting_confirmation"))))
          .orderBy(desc(invoices.issuedAt))
          .limit(1)
      )[0];
      const msg = composeReminder(due, {
        tenantName: r.tenantName,
        slug: r.slug,
        planName: r.planName,
        status: snap.status,
        invoice: inv ? { number: inv.number, amount: inv.amount, currency: inv.currency } : null,
        graceUntil: snap.graceUntil,
        billingEmail: d.billingEmail,
      });
      const admins = await tenantAdminEmails(d.db, r.clientId);
      const res = await sendOnce(d, {
        key: reminderKey(r.id, due),
        kind: due.kind,
        subscriptionId: r.id,
        clientId: r.clientId,
        to: admins.length > 0 ? admins : [d.billingEmail],
        cc: admins.length > 0 ? [d.billingEmail] : [],
        ...msg,
      });
      report.reminders[res]++;
      if (res === "sent") {
        await audit(d.db, {
          action: "subscription.reminder_sent",
          targetType: "subscription",
          targetId: r.id,
          clientId: r.clientId,
          result: "success",
          metadata: { kind: due.kind, period: due.period, recipients: admins.length + 1 },
        });
      }
    } catch (err) {
      report.errors++;
      d.logger.error({ subscriptionId: r.id, err: safeErrorMessage(err) }, "subscription_tick: pengingat gagal");
    }
  }
}

async function processAdminCheck(d: TickDeps, report: TickReport): Promise<void> {
  const tenants = await d.db
    .select({ id: clients.id, slug: clients.slug, isPlatform: clients.isPlatform, status: clients.status, terminatedAt: clients.terminatedAt })
    .from(clients);
  const admins = await d.db
    .select({ clientId: users.clientId })
    .from(users)
    .where(and(eq(users.role, "client_admin"), inArray(users.status, ["invited", "active"]), isNotNull(users.clientId)));
  const missing = tenantsWithoutAdmin(tenants, new Set(admins.map((a) => a.clientId as string)));
  report.tenantsWithoutAdmin = missing.length;
  for (const m of missing) {
    await audit(d.db, {
      action: "tenant.admin_missing",
      targetType: "client",
      targetId: m.id,
      clientId: m.id,
      result: "failure",
      metadata: { today: d.today, rule: "adr0018_d3" },
    });
  }
  // Keputusan Lead (integrasi Fase 1): email ke billing HANYA bila himpunan berubah dibanding notifikasi terakhir.
  // Notifikasi terakhir = baris `admin_check` terbaru berstatus sent (gagal dicoba ulang lewat sendOnce per kunci hari itu).
  if (!d.mailer) return;
  const fp = adminSetFingerprint(missing.map((m) => m.id));
  const last = (
    await d.db
      .select({ key: notificationLog.key })
      .from(notificationLog)
      .where(and(eq(notificationLog.kind, "admin_check"), eq(notificationLog.status, "sent")))
      .orderBy(desc(notificationLog.createdAt), desc(notificationLog.key))
      .limit(1)
  )[0];
  const decision = adminNotifyDecision(fp, last ? fingerprintFromAdminKey(last.key) : null);
  report.adminCheck = decision;
  if (decision === "email") {
    const msg = composeAdminReport(d.today, missing.map((m) => m.slug).sort());
    await sendOnce(d, { key: adminCheckKey(d.today, fp), kind: "admin_check", subscriptionId: null, clientId: null, to: [d.billingEmail], cc: [], ...msg });
  } else if (decision === "mark") {
    // Himpunan kembali kosong: penanda tanpa email (recipient_count 0) — bila tenant yang sama kehilangan admin lagi,
    // itu perubahan dan billing dikabari lagi.
    await d.db
      .insert(notificationLog)
      .values({ key: adminCheckKey(d.today, fp), kind: "admin_check", status: "sent", attempts: 0, recipientCount: 0, sentAt: d.now })
      .onConflictDoNothing({ target: notificationLog.key });
  }
}

export async function runSubscriptionTick(d: TickDeps): Promise<TickReport> {
  const report: TickReport = {
    today: d.today,
    transitions: 0,
    suspendJobs: 0,
    invoicesIssued: 0,
    anomalies: 0,
    errors: 0,
    deferred: 0,
    reminders: { sent: 0, skipped: 0, failed: 0 },
    tenantsWithoutAdmin: 0,
    adminCheck: "skipped",
  };
  await processTransitions(d, report);
  await processReminders(d, report);
  try {
    await processAdminCheck(d, report);
  } catch (err) {
    report.errors++;
    d.logger.error({ err: safeErrorMessage(err) }, "subscription_tick: cek tenant-admin gagal");
  }
  d.logger.info({ ...report }, "subscription_tick selesai");
  return report;
}
