/**
 * Domains tenant (W5, ADR 0018 D1; brief §DNS) — modul MURNI (diuji unit): form CRUD (Zod `.strict()`), aturan tautan
 * environment, dan checklist DNS yang digenerate per domain. Verifikasi DNS otomatis (`dns_verify`) = Fase 2.
 */
import { z } from "zod";
import { formToObject } from "./job-forms";
import { UUID_REGEX } from "./job-contract";

export const DOMAIN_PURPOSES = ["odoo", "web", "mail", "insight", "sso"] as const;
export type DomainPurpose = (typeof DOMAIN_PURPOSES)[number];

/** Purpose yang boleh ditautkan ke environment Odoo tenant (brief: environment link untuk odoo/web). */
export const ENV_LINK_PURPOSES: readonly DomainPurpose[] = ["odoo", "web"];

/** FQDN huruf kecil tanpa titik akhir: ≥ 2 label, label 1–63 [a-z0-9-] tanpa tanda hubung di tepi, TLD huruf, ≤ 253. */
export const DOMAIN_FQDN_REGEX = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** Nilai TXT DKIM (mis. `v=DKIM1; k=rsa; p=MIIB…`): ASCII tercetak tanpa kutip/backslash, ≤ 2048. */
export const DKIM_TXT_REGEX = /^[A-Za-z0-9=;+/ ._:-]{1,2048}$/;

const uuid = z.string().regex(UUID_REGEX);
const fqdn = z
  .string()
  .trim()
  .toLowerCase()
  .transform((v) => v.replace(/\.$/, ""))
  .pipe(z.string().regex(DOMAIN_FQDN_REGEX));
const optionalUuid = z
  .string()
  .transform((v) => (v === "" ? undefined : v))
  .pipe(uuid.optional())
  .optional();
const dkim = z
  .string()
  .trim()
  .transform((v) => (v === "" ? undefined : v.replace(/\s+/g, " ")))
  .pipe(z.string().regex(DKIM_TXT_REGEX).optional())
  .optional();

export const domainFormSchemas = {
  createDomain: z.object({ clientId: uuid, fqdn, purpose: z.enum(DOMAIN_PURPOSES), environmentId: optionalUuid, dkim_txt: dkim }).strict(),
  /** fqdn tidak bisa diubah (hapus + buat ulang); purpose, tautan environment, DKIM boleh. */
  updateDomain: z.object({ domainId: uuid, purpose: z.enum(DOMAIN_PURPOSES), environmentId: optionalUuid, dkim_txt: dkim }).strict(),
  /** Hapus: ketik fqdn persis (konfirmasi aksi berisiko). */
  deleteDomain: z.object({ domainId: uuid, confirm: z.string().trim().toLowerCase().max(253) }).strict(),
} as const;

export type DomainFormName = keyof typeof domainFormSchemas;
export type DomainFormData<N extends DomainFormName> = z.infer<(typeof domainFormSchemas)[N]>;

export function parseDomainForm<N extends DomainFormName>(
  name: N,
  entries: Iterable<[string, FormDataEntryValue]>,
): { success: true; data: DomainFormData<N> } | { success: false } {
  const obj = formToObject(entries);
  if (!obj) return { success: false };
  const r = domainFormSchemas[name].safeParse(obj);
  return r.success ? { success: true, data: r.data as DomainFormData<N> } : { success: false };
}

/** Aturan tautan environment (murni): hanya odoo/web, dan environment harus milik tenant domain. */
export function envLinkAllowed(purpose: DomainPurpose, env: { clientId: string } | null, clientId: string): boolean {
  if (env === null) return true;
  return ENV_LINK_PURPOSES.includes(purpose) && env.clientId === clientId;
}

// ---------------------------------------------------------------------------
// Checklist DNS
// ---------------------------------------------------------------------------
export const MAIL_MX_HOST = "mail.bimacreative.tech.";
export const MAIL_SPF = "v=spf1 include:_spf.bimacreative.tech -all";
export const DKIM_SELECTOR = "mail";

export interface DnsRecord {
  type: "A" | "MX" | "TXT";
  /** Nama relatif zona domain (`@` = domain itu sendiri). */
  host: string;
  /** Nama lengkap (FQDN) record. */
  name: string;
  /** Nilai yang harus dipasang; null = belum tersedia (lihat `pending`). */
  value: string | null;
  /** Alasan nilai belum tersedia (mis. IP belum dikonfigurasi, menunggu DKIM). */
  pending?: string;
  priority?: number;
}

export interface DnsChecklist {
  records: DnsRecord[];
  notes: string[];
}

/**
 * Checklist DNS per domain (brief Fase 1):
 * - odoo/web/insight: `A <fqdn> <PLATFORM_PUBLIC_IPV4>` (tanpa AAAA);
 * - mail: `MX 10 mail.bimacreative.tech.`, SPF, DKIM selector `mail` (nilai dari data domain atau "menunggu DKIM"),
 *   DMARC `p=none` (naikkan ke quarantine setelah 2 minggu bersih);
 * - sso: belum ditetapkan (Fase berikutnya).
 */
export function dnsChecklist(d: { fqdn: string; purpose: DomainPurpose | null; dkimTxt: string | null }, platformIpv4: string | null): DnsChecklist {
  const fq = d.fqdn;
  switch (d.purpose) {
    case "odoo":
    case "web":
    case "insight":
      return {
        records: [
          platformIpv4
            ? { type: "A", host: "@", name: fq, value: platformIpv4 }
            : { type: "A", host: "@", name: fq, value: null, pending: "IP belum dikonfigurasi" },
        ],
        notes: ["Jangan buat record AAAA (platform belum melayani IPv6).", "Hapus record A/CNAME lain untuk nama yang sama."],
      };
    case "mail":
      return {
        records: [
          { type: "MX", host: "@", name: fq, value: MAIL_MX_HOST, priority: 10 },
          { type: "TXT", host: "@", name: fq, value: `"${MAIL_SPF}"` },
          d.dkimTxt
            ? { type: "TXT", host: `${DKIM_SELECTOR}._domainkey`, name: `${DKIM_SELECTOR}._domainkey.${fq}`, value: `"${d.dkimTxt}"` }
            : { type: "TXT", host: `${DKIM_SELECTOR}._domainkey`, name: `${DKIM_SELECTOR}._domainkey.${fq}`, value: null, pending: "menunggu DKIM" },
          { type: "TXT", host: "_dmarc", name: `_dmarc.${fq}`, value: `"v=DMARC1; p=none; adkim=s; aspf=s; rua=mailto:dmarc@${fq}"` },
        ],
        notes: [
          "Hanya satu record SPF per domain — gabungkan bila sudah ada SPF lain.",
          "DMARC dimulai p=none; naikkan ke p=quarantine setelah 2 minggu laporan bersih.",
        ],
      };
    default:
      return { records: [], notes: ["Checklist DNS untuk kegunaan ini belum ditetapkan (Fase berikutnya)."] };
  }
}
