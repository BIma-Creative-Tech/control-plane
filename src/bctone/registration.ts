/**
 * Layanan registrasi self-serve BCTOne (US-01..04, D-2 kapasitas, BR-02 review). Dipakai Server Action publik
 * `/daftar` (tanpa sesi) dan halaman admin `/registrations` (superadmin). DB disuntik (diuji integrasi).
 *
 * Keamanan: registran belum punya akun → setiap langkah terikat cookie HMAC (id registrasi) + email terverifikasi OTP.
 * OTP dibuat & dikirim WORKER (kode tidak lewat web/antrean). Batas: per IP, per email, global per jam (anti-spam).
 * Provisioning memakai onboardTenant (rantai job yang sama dengan onboarding admin) dengan aktor sistem.
 */
import { and, count, eq, gte, inArray, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { auditLogs, bctoneRegistrations, clients, environments, plans, subscriptions } from "../db/schema";
import { writeAiConsentTx } from "../ai/consent";
import {
  OTP_MAX_ATTEMPTS,
  OTP_PER_EMAIL_HOUR,
  START_GLOBAL_HOUR,
  START_PER_IP_HOUR,
  TIER_PLAN,
  emailDigest,
  minimumTier,
  needsReview,
  otpMatches,
  tierRank,
  type BctoneTier,
  type Industry,
} from "../lib/bctone-register";
import { defaultHost, envAllowedForInstance, realmEnvForInstance, type BridgeJobType, type Instance } from "../lib/job-contract";
import type { AiConsent } from "../lib/ai-gateway";
import { onboardTenant, type TenantActionOutcome } from "../jobs/tenants";
import type { Actor, RequestMeta, SendFn } from "../jobs/service";

export type Registration = typeof bctoneRegistrations.$inferSelect;

/** Aktor sistem untuk provisioning otomatis (sama dengan izin onboarding admin; tercatat di audit sebagai sistem). */
export const REGISTER_ACTOR: Actor = { sub: "system-bctone-register", userId: null, roles: ["superadmin"] };

export async function loadRegistration(db: Db, id: string): Promise<Registration | null> {
  return (await db.select().from(bctoneRegistrations).where(eq(bctoneRegistrations.id, id)).limit(1))[0] ?? null;
}

async function audit(db: Db | Parameters<Parameters<Db["transaction"]>[0]>[0], r: { id: string; email: string; clientId?: string | null }, action: string, result: "success" | "rejected", md: Record<string, unknown>, meta: RequestMeta) {
  await db.insert(auditLogs).values({
    actor: `registrant:${emailDigest(r.email)}`,
    action,
    targetType: "registration",
    targetId: r.id,
    clientId: r.clientId ?? null,
    result,
    ip: meta.ip,
    requestId: meta.requestId,
    metadata: md,
  });
}

export type StartOutcome = { ok: true; id: string } | { ok: false; reason: "rate_limited" | "slug_taken" };

/** Langkah 1: buat registrasi draft (belum ada email terkirim — worker mengirim OTP setelah enqueue). */
export async function startRegistration(
  db: Db,
  p: { email: string; ownerName: string; businessName: string; slug: string; meta: RequestMeta; now?: Date },
): Promise<StartOutcome> {
  const now = p.now ?? new Date();
  const hourAgo = new Date(now.getTime() - 3600_000);
  const [g] = await db.select({ n: count() }).from(bctoneRegistrations).where(gte(bctoneRegistrations.createdAt, hourAgo));
  const ipN = p.meta.ip
    ? (await db.select({ n: count() }).from(bctoneRegistrations).where(and(eq(bctoneRegistrations.ip, p.meta.ip), gte(bctoneRegistrations.createdAt, hourAgo))))[0]!.n
    : 0;
  const [em] = await db
    .select({ n: count() })
    .from(bctoneRegistrations)
    .where(and(eq(bctoneRegistrations.email, p.email), gte(bctoneRegistrations.createdAt, hourAgo)));
  if (g!.n >= START_GLOBAL_HOUR || ipN >= START_PER_IP_HOUR || em!.n >= OTP_PER_EMAIL_HOUR) {
    return { ok: false, reason: "rate_limited" };
  }
  if (await slugUnavailable(db, p.slug)) return { ok: false, reason: "slug_taken" };
  const row = (
    await db
      .insert(bctoneRegistrations)
      .values({ email: p.email, ownerName: p.ownerName, businessName: p.businessName, slug: p.slug, ip: p.meta.ip, createdAt: now, updatedAt: now })
      .returning({ id: bctoneRegistrations.id })
  )[0]!;
  await audit(db, { id: row.id, email: p.email }, "registration.start", "success", { slug: p.slug, email_hash: emailDigest(p.email) }, p.meta);
  return { ok: true, id: row.id };
}

/** Slug sudah dipakai tenant, atau sedang diproses registrasi lain yang lolos verifikasi. */
export async function slugUnavailable(db: Db, slug: string, exceptId?: string): Promise<boolean> {
  const c = await db.select({ id: clients.id }).from(clients).where(eq(clients.slug, slug)).limit(1);
  if (c.length > 0) return true;
  const r = await db
    .select({ id: bctoneRegistrations.id })
    .from(bctoneRegistrations)
    .where(and(eq(bctoneRegistrations.slug, slug), inArray(bctoneRegistrations.status, ["review", "waitlist", "provisioning", "done"])))
    .limit(1);
  return r.length > 0 && r[0]!.id !== exceptId;
}

export type OtpOutcome = { ok: true } | { ok: false; reason: "expired" | "wrong" | "locked" | "state" };

export async function verifyOtp(db: Db, id: string, code: string, meta: RequestMeta, now = new Date()): Promise<OtpOutcome> {
  return db.transaction(async (tx) => {
    const r = (await tx.select().from(bctoneRegistrations).where(eq(bctoneRegistrations.id, id)).for("update").limit(1))[0];
    if (!r || r.status !== "draft") return { ok: false, reason: "state" } as const;
    if (r.otpAttempts >= OTP_MAX_ATTEMPTS) return { ok: false, reason: "locked" } as const;
    if (!r.otpHash || !r.otpSalt || !r.otpExpiresAt || r.otpExpiresAt < now) return { ok: false, reason: "expired" } as const;
    if (!otpMatches(r.otpSalt, r.otpHash, code)) {
      await tx.update(bctoneRegistrations).set({ otpAttempts: r.otpAttempts + 1, updatedAt: now }).where(eq(bctoneRegistrations.id, id));
      return { ok: false, reason: r.otpAttempts + 1 >= OTP_MAX_ATTEMPTS ? "locked" : "wrong" } as const;
    }
    await tx
      .update(bctoneRegistrations)
      .set({ status: "verified", verifiedAt: now, otpHash: null, otpSalt: null, otpExpiresAt: null, updatedAt: now })
      .where(eq(bctoneRegistrations.id, id));
    await audit(tx, r, "registration.verify", "success", {}, meta);
    return { ok: true } as const;
  });
}

/** Simpan isian langkah (hanya registrasi terverifikasi & belum diajukan). */
export async function saveStep(
  db: Db,
  id: string,
  patch: Partial<{ industry: Industry; outlets: number; modules: string[] | null; extraNeeds: string | null; tier: BctoneTier | null; aiConsent: AiConsent }>,
  now = new Date(),
): Promise<boolean> {
  const r = await db
    .update(bctoneRegistrations)
    .set({ ...patch, updatedAt: now })
    .where(and(eq(bctoneRegistrations.id, id), eq(bctoneRegistrations.status, "verified")))
    .returning({ id: bctoneRegistrations.id });
  return r.length === 1;
}

/** Tenant BCTOne self-serve yang aktif (kapasitas pool D-2). */
export async function activeBctoneTenants(db: Db): Promise<number> {
  const [r] = await db
    .select({ n: count() })
    .from(subscriptions)
    .innerJoin(plans, eq(plans.id, subscriptions.planId))
    .where(and(eq(subscriptions.lifecycle, "self_serve"), inArray(subscriptions.status, ["active", "past_due", "suspended"])));
  return r!.n;
}

export interface ProvisionContext {
  instance: Instance | undefined;
  allowedTypes: readonly BridgeJobType[];
  capacity: number;
  send: SendFn;
  meta: RequestMeta;
}

export type SubmitOutcome =
  | { ok: true; status: "review" | "waitlist" | "provisioning"; chainId?: string }
  | { ok: false; reason: "state" | "incomplete" | "slug_taken" | "disabled" | "provision_failed"; detail?: string };

/** Langkah akhir: ajukan. Free/UMKM + muat kapasitas → provisioning; selain itu review/waitlist (owner). */
export async function submitRegistration(db: Db, id: string, ctx: ProvisionContext, now = new Date()): Promise<SubmitOutcome> {
  const r = await loadRegistration(db, id);
  if (!r || r.status !== "verified") return { ok: false, reason: "state" };
  if (!r.industry || !r.outlets || !r.modules?.length || !r.tier || !r.aiConsent) return { ok: false, reason: "incomplete" };
  const tier = r.tier as BctoneTier;
  if (tierRank(tier) < tierRank(minimumTier(r.modules, r.outlets))) return { ok: false, reason: "incomplete" };
  if (await slugUnavailable(db, r.slug, r.id)) return { ok: false, reason: "slug_taken" };
  let status: "review" | "waitlist" | "provisioning";
  if (needsReview(tier, r.extraNeeds)) status = "review";
  else if ((await activeBctoneTenants(db)) >= ctx.capacity) status = "waitlist";
  else status = "provisioning";
  const claimed = await db
    .update(bctoneRegistrations)
    .set({ status: status === "provisioning" ? "provisioning" : status, submittedAt: now, updatedAt: now })
    .where(and(eq(bctoneRegistrations.id, id), eq(bctoneRegistrations.status, "verified")))
    .returning({ id: bctoneRegistrations.id });
  if (claimed.length !== 1) return { ok: false, reason: "state" };
  await audit(db, r, "registration.submit", "success", { tier, status, modules: r.modules, outlets: r.outlets, extra: r.extraNeeds !== null }, ctx.meta);
  if (status !== "provisioning") return { ok: true, status };
  const p = await provisionRegistration(db, id, ctx, REGISTER_ACTOR);
  return p.ok ? { ok: true, status, chainId: p.chainId } : { ok: false, reason: "provision_failed", detail: p.detail };
}

/** Provisioning (otomatis atau setelah disetujui owner): onboardTenant + consent AI + status registrasi. */
export async function provisionRegistration(
  db: Db,
  id: string,
  ctx: ProvisionContext,
  actor: Actor,
): Promise<{ ok: true; chainId: string; clientId: string } | { ok: false; detail: string }> {
  const r = await loadRegistration(db, id);
  if (!r || !["provisioning", "review", "waitlist"].includes(r.status)) return { ok: false, detail: "state" };
  const fail = async (detail: string) => {
    await db.update(bctoneRegistrations).set({ status: "failed", reviewNote: detail, updatedAt: new Date() }).where(eq(bctoneRegistrations.id, id));
    await audit(db, r, "registration.provision", "rejected", { detail }, ctx.meta);
    return { ok: false as const, detail };
  };
  if (!ctx.instance) return fail("disabled");
  const env = realmEnvForInstance(ctx.instance);
  const host = defaultHost(r.slug, env);
  if (!host || !envAllowedForInstance(ctx.instance, env)) return fail("no_env");
  const planCode = TIER_PLAN[r.tier as BctoneTier];
  const plan = planCode ? (await db.select({ id: plans.id }).from(plans).where(and(eq(plans.code, planCode), eq(plans.isActive, true))).limit(1))[0] : undefined;
  if (!plan) return fail("plan_inactive");
  const out: TenantActionOutcome = await onboardTenant(db, ctx.send, {
    instance: ctx.instance,
    allowedTypes: ctx.allowedTypes,
    actor,
    meta: ctx.meta,
    form: {
      slug: r.slug,
      name: r.businessName,
      brand: null,
      adminEmail: r.email,
      adminName: r.ownerName,
      envs: [{ kind: env, host }],
      planId: plan.id,
      pack: r.industry === "fnb" || r.industry === "retail" ? r.industry : null,
    },
  });
  if (!out.ok) return fail(`onboard:${out.reason}${"detail" in out && out.detail ? `:${String(out.detail)}` : ""}`);
  await db.transaction(async (tx) => {
    if (r.aiConsent) await writeAiConsentTx(tx, out.clientId, r.aiConsent, `registrant:${emailDigest(r.email)}`, new Date());
    await tx
      .update(bctoneRegistrations)
      .set({ status: "provisioning", clientId: out.clientId, chainId: out.chainId, updatedAt: new Date() })
      .where(eq(bctoneRegistrations.id, id));
  });
  await audit(db, { ...r, clientId: out.clientId }, "registration.provision", "success", { chain_id: out.chainId, jobs: out.jobIds.length }, ctx.meta);
  return { ok: true, chainId: out.chainId, clientId: out.clientId };
}

/**
 * Progres provisioning (halaman "Selesai" + penutupan registrasi): status job TERBARU per (tipe, env) tenant — "Ulangi
 * dari langkah ini" membuat rantai baru, jadi rantai awal saja tidak cukup. Ringkas, tanpa detail teknis.
 */
export async function registrationProgress(
  db: Db,
  r: Pick<Registration, "clientId">,
): Promise<{ total: number; done: number; failed: number; active: number; host: string | null }> {
  if (!r.clientId) return { total: 0, done: 0, failed: 0, active: 0, host: null };
  const rows = await db.execute<{ status: string }>(sql`
    SELECT DISTINCT ON (type, env) status FROM provision_jobs
    WHERE client_id = ${r.clientId} AND dry_run = false
    ORDER BY type, env, created_at DESC`);
  const st = rows.rows.map((x) => x.status);
  const env = (await db.select({ host: environments.host }).from(environments).where(eq(environments.clientId, r.clientId)).limit(1))[0];
  return {
    total: st.length,
    done: st.filter((s) => s === "succeeded").length,
    failed: st.filter((s) => s === "failed" || s === "cancelled").length,
    active: st.filter((s) => s === "queued" || s === "dispatched" || s === "running").length,
    host: env?.host ?? null,
  };
}

/** Worker: registrasi `provisioning` yang semua langkah terbarunya sukses → `done`. Return jumlah yang ditutup. */
export async function settleRegistrations(db: Db): Promise<number> {
  const open = await db
    .select({ id: bctoneRegistrations.id, clientId: bctoneRegistrations.clientId, email: bctoneRegistrations.email })
    .from(bctoneRegistrations)
    .where(and(eq(bctoneRegistrations.status, "provisioning"), sql`${bctoneRegistrations.clientId} IS NOT NULL`))
    .limit(50);
  let n = 0;
  for (const r of open) {
    const p = await registrationProgress(db, r);
    if (p.total === 0 || p.active > 0 || p.failed > 0 || p.done !== p.total) continue;
    const u = await db
      .update(bctoneRegistrations)
      .set({ status: "done", updatedAt: new Date() })
      .where(and(eq(bctoneRegistrations.id, r.id), eq(bctoneRegistrations.status, "provisioning")))
      .returning({ id: bctoneRegistrations.id });
    if (u.length === 1) {
      n++;
      await audit(db, r, "registration.done", "success", { steps: p.total }, { ip: null, requestId: null });
    }
  }
  return n;
}

/** Owner menolak registrasi review/waitlist. */
export async function rejectRegistration(db: Db, id: string, note: string, meta: RequestMeta): Promise<boolean> {
  const r = await loadRegistration(db, id);
  if (!r || !["review", "waitlist"].includes(r.status)) return false;
  await db.update(bctoneRegistrations).set({ status: "rejected", reviewNote: note, updatedAt: new Date() }).where(eq(bctoneRegistrations.id, id));
  await audit(db, r, "registration.reject", "success", { note_len: note.length }, meta);
  return true;
}
