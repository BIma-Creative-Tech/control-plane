"use server";

/**
 * Server Actions Domains (W5) di halaman tenant: requirePermission(domains:manage = superadmin) → Origin fail-closed →
 * Zod `.strict()` → aktor (sub Keycloak) → layanan jobs/domains.ts (izin dicek ulang + transaksi + audit) → redirect
 * ke halaman tenant dengan kode ter-whitelist. Tidak ada aksi DNS (verifikasi otomatis = Fase 2).
 */
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@/db";
import { getWebEnv } from "@/env";
import { createDomain, deleteDomain, domainOutcomeCode, updateDomain, type DomainOutcome, type DomainServiceInput } from "@/jobs/domains";
import { requirePermission } from "@/lib/authz";
import { parseDomainForm, type DomainFormData, type DomainFormName } from "@/lib/domains";
import type { ActionResultCode } from "@/lib/job-list-params";
import { logger } from "@/lib/logger";
import { SLUG_REGEX } from "@/lib/slug";
import { actorFromSession, assertSameOrigin, requestMeta } from "@/server/context";

function back(slug: string | null, code: ActionResultCode): never {
  redirect(slug ? `/clients/${slug}?r=${code}#domains` : `/clients?r=${code}`);
}

async function handle<N extends DomainFormName>(
  form: N,
  kind: "create" | "update" | "delete",
  formData: FormData,
  call: (svc: DomainServiceInput, d: DomainFormData<N>) => Promise<DomainOutcome>,
): Promise<never> {
  const session = await requirePermission("domains:manage");
  // `back` (slug halaman asal) hanya untuk redirect saat gagal sebelum layanan — bukan bagian skema aksi.
  const rawBack = formData.get("back");
  const backSlug = typeof rawBack === "string" && SLUG_REGEX.test(rawBack) ? rawBack : null;
  formData.delete("back");
  if (!(await assertSameOrigin())) back(backSlug, "origin");
  const parsed = parseDomainForm(form, formData.entries());
  if (!parsed.success) back(backSlug, "invalid");
  const actor = await actorFromSession(session);
  if (!actor) back(backSlug, "reauth");
  let outcome: DomainOutcome;
  try {
    outcome = await call({ actor, meta: await requestMeta(), platformDomains: getWebEnv().PLATFORM_DOMAINS }, parsed.data);
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.name : "error", form }, "aksi domain gagal");
    back(backSlug, "error");
  }
  if (!outcome.ok && outcome.reason === "error") logger.error({ err: outcome.message, form }, "aksi domain gagal");
  revalidatePath("/clients");
  back((outcome.ok ? outcome.slug : outcome.slug) ?? backSlug, domainOutcomeCode(outcome, kind));
}

export async function createDomainAction(formData: FormData): Promise<void> {
  await handle("createDomain", "create", formData, (svc, d) =>
    createDomain(getDb(), svc, { clientId: d.clientId, fqdn: d.fqdn, purpose: d.purpose, environmentId: d.environmentId, dkimTxt: d.dkim_txt }),
  );
}

export async function updateDomainAction(formData: FormData): Promise<void> {
  await handle("updateDomain", "update", formData, (svc, d) =>
    updateDomain(getDb(), svc, { domainId: d.domainId, purpose: d.purpose, environmentId: d.environmentId, dkimTxt: d.dkim_txt }),
  );
}

export async function deleteDomainAction(formData: FormData): Promise<void> {
  await handle("deleteDomain", "delete", formData, (svc, d) => deleteDomain(getDb(), svc, { domainId: d.domainId, confirm: d.confirm }));
}
