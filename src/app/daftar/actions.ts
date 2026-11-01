"use server";

/**
 * Server Action PUBLIK wizard registrasi BCTOne `/daftar` (tanpa sesi login). Pertahanan: kill switch env, Origin
 * fail-closed, Zod strict per langkah, cookie HMAC (id registrasi), email terverifikasi OTP sebelum langkah 3+, batas
 * per IP/email/global (bctone/registration.ts). Tenant & harga ditentukan server. Kode hasil ter-whitelist.
 */
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  loadRegistration,
  saveStep,
  startRegistration,
  submitRegistration,
  verifyOtp,
} from "@/bctone/registration";
import { getDb } from "@/db";
import { getWebEnv } from "@/env";
import {
  REG_COOKIE,
  REG_COOKIE_MAX_AGE,
  businessSchema,
  consentSchema,
  minimumTier,
  otpSchema,
  parseModules,
  planSchema,
  selectableTiers,
  signRegCookie,
  startSchema,
  submitSchema,
  verifyRegCookie,
  type BctoneTier,
  type Industry,
  type WizardStep,
} from "@/lib/bctone-register";
import { formToObject } from "@/lib/job-forms";
import { instanceJobTypes } from "@/lib/job-contract";
import { logger } from "@/lib/logger";
import { getSendFn, requestRegistrationOtp } from "@/server/boss";
import { assertSameOrigin, requestMeta } from "@/server/context";

function go(step: WizardStep, e?: string): never {
  redirect(`/daftar?s=${step}${e ? `&e=${e}` : ""}`);
}

async function common(formData: FormData, step: WizardStep): Promise<{ raw: Record<string, string>; secret: string }> {
  const env = getWebEnv();
  if (env.BCTONE_REGISTER_ENABLED !== "1") redirect("/daftar");
  if (!(await assertSameOrigin())) go(step, "origin");
  const raw = formToObject(formData.entries());
  if (!raw) go(step, "invalid");
  return { raw, secret: env.AUTH_SECRET };
}

async function currentId(secret: string): Promise<string | null> {
  return verifyRegCookie(secret, (await cookies()).get(REG_COOKIE)?.value);
}

/** Registrasi milik cookie ini dengan status yang diharapkan; selain itu kembali ke awal. */
async function requireReg(secret: string, status: "draft" | "verified") {
  const id = await currentId(secret);
  const r = id ? await loadRegistration(getDb(), id) : null;
  if (!r) go("akun", "session");
  if (r.status !== status) go(r.status === "draft" ? "verifikasi" : r.status === "verified" ? "bisnis" : "selesai");
  return r;
}

export async function registerStartAction(formData: FormData): Promise<void> {
  const { raw, secret } = await common(formData, "akun");
  const p = startSchema.safeParse(raw);
  if (!p.success) go("akun", p.error.issues.some((i) => i.message === "slug") ? "slug" : "invalid");
  const meta = await requestMeta();
  const r = await startRegistration(getDb(), {
    email: p.data.email,
    ownerName: p.data.owner_name,
    businessName: p.data.business_name,
    slug: p.data.slug,
    meta,
  });
  if (!r.ok) go("akun", r.reason);
  (await cookies()).set(REG_COOKIE, signRegCookie(secret, r.id), {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/daftar",
    maxAge: REG_COOKIE_MAX_AGE,
  });
  try {
    await requestRegistrationOtp(r.id);
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.name : "error" }, "antre OTP gagal");
  }
  go("verifikasi");
}

export async function registerResendAction(formData: FormData): Promise<void> {
  const { secret } = await common(formData, "verifikasi");
  const r = await requireReg(secret, "draft");
  try {
    await requestRegistrationOtp(r.id);
  } catch {
    go("verifikasi", "error");
  }
  go("verifikasi", "resent");
}

export async function registerVerifyAction(formData: FormData): Promise<void> {
  const { raw, secret } = await common(formData, "verifikasi");
  const p = otpSchema.safeParse(raw);
  if (!p.success) go("verifikasi", "otp_wrong");
  const r = await requireReg(secret, "draft");
  const v = await verifyOtp(getDb(), r.id, p.data.code, await requestMeta());
  if (!v.ok) go("verifikasi", `otp_${v.reason}`);
  go("bisnis");
}

export async function registerBusinessAction(formData: FormData): Promise<void> {
  const { raw, secret } = await common(formData, "bisnis");
  const p = businessSchema.safeParse(raw);
  if (!p.success) go("bisnis", "invalid");
  const r = await requireReg(secret, "verified");
  // ganti industri → pilihan modul lama tidak berlaku
  const reset = r.industry !== p.data.industry ? { modules: [] as string[], extraNeeds: null } : {};
  await saveStep(getDb(), r.id, { industry: p.data.industry, outlets: p.data.outlets, ...reset });
  go("modul");
}

export async function registerModulesAction(formData: FormData): Promise<void> {
  const { raw, secret } = await common(formData, "modul");
  const r = await requireReg(secret, "verified");
  if (!r.industry || !r.outlets) go("bisnis");
  const m = parseModules(raw, r.industry as Industry);
  if (!m.ok) go("modul", "modules");
  const min = minimumTier(m.modules, r.outlets);
  const keepTier = r.tier && selectableTiers(min).includes(r.tier as BctoneTier) ? {} : { tier: min === "enterprise" ? "bisnis" : min };
  await saveStep(getDb(), r.id, { modules: m.modules, extraNeeds: m.extra, ...(keepTier as { tier?: BctoneTier }) });
  go("paket");
}

export async function registerPlanAction(formData: FormData): Promise<void> {
  const { raw, secret } = await common(formData, "paket");
  const p = planSchema.safeParse(raw);
  if (!p.success) go("paket", "invalid");
  const r = await requireReg(secret, "verified");
  if (!r.modules?.length || !r.outlets) go("modul");
  if (!selectableTiers(minimumTier(r.modules, r.outlets)).includes(p.data.tier)) go("paket", "tier");
  await saveStep(getDb(), r.id, { tier: p.data.tier });
  go("privasi");
}

export async function registerConsentAction(formData: FormData): Promise<void> {
  const { raw, secret } = await common(formData, "privasi");
  const p = consentSchema.safeParse(raw);
  if (!p.success) go("privasi", "consent");
  const r = await requireReg(secret, "verified");
  await saveStep(getDb(), r.id, { aiConsent: p.data.consent });
  go("ringkasan");
}

export async function registerSubmitAction(formData: FormData): Promise<void> {
  const { raw, secret } = await common(formData, "ringkasan");
  if (!submitSchema.safeParse(raw).success) go("ringkasan", "confirm");
  const r = await requireReg(secret, "verified");
  const env = getWebEnv();
  let code: string | undefined;
  try {
    const out = await submitRegistration(getDb(), r.id, {
      instance: env.INFRA_JOBS_INSTANCE,
      allowedTypes: instanceJobTypes(env.INFRA_JOBS_TYPES),
      capacity: env.BCTONE_CAPACITY,
      send: await getSendFn(),
      meta: await requestMeta(),
    });
    if (!out.ok) code = out.reason;
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.name : "error" }, "submit registrasi gagal");
    code = "error";
  }
  if (code && code !== "provision_failed") go("ringkasan", code);
  go("selesai");
}
