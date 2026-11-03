/**
 * Registrasi self-serve BCTOne (US-01..US-04, BR-01..BR-05, D-2) — modul MURNI (tanpa Next/DB), diuji unit.
 * Katalog modul + badge tier, paket minimum dari modul & outlet, validasi form per langkah, cookie sesi registran
 * (HMAC), OTP (hash bergaram). Harga TIDAK pernah dihasilkan LLM (BR-03): dari plans.price_amount + lib/bctone-tax.ts.
 */
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { BCTONE_PACK_ARGS, EMAIL_MAX, EMAIL_REGEX, PLATFORM_SLUG, asciiName } from "./job-contract";
import { SLUG_REGEX } from "./slug";

export const BCTONE_TIERS = ["free", "umkm", "bisnis", "enterprise"] as const;
export type BctoneTier = (typeof BCTONE_TIERS)[number];
export const TIER_LABEL: Record<BctoneTier, string> = { free: "Gratis", umkm: "UMKM", bisnis: "Bisnis", enterprise: "Enterprise" };
export const TIER_PLAN: Record<BctoneTier, string | null> = { free: "bctone-free", umkm: "bctone-umkm", bisnis: "bctone-bisnis", enterprise: null };
export const tierRank = (t: BctoneTier): number => BCTONE_TIERS.indexOf(t);

/** Jenis usaha = pack modul Odoo dispatcher (BCTONE_PACKS infra; modul per pack di scripts/bctone-tenant-config.sh). */
export const INDUSTRIES = BCTONE_PACK_ARGS;
export type Industry = (typeof INDUSTRIES)[number];
export const INDUSTRY_LABEL: Record<Industry, string> = {
  fnb: "F&B (kafe, resto, bakery)",
  retail: "Retail (toko, minimarket, butik)",
  jasa: "Jasa (konsultan, agensi, IT, kreatif, profesional)",
  bengkel: "Bengkel & servis (otomotif, elektronik, gadget)",
  distribusi: "Distribusi & grosir",
  manufaktur: "Manufaktur & produksi",
  kecantikan: "Salon, barbershop & kecantikan",
  lainnya: "Lainnya / usaha umum",
};
const ALL: readonly Industry[] = INDUSTRIES;

export interface ModuleDef {
  code: string;
  name: string;
  desc: string;
  tier: BctoneTier;
  industries: readonly Industry[];
}

/** Katalog modul (BR-04: hanya modul ini yang diprovision; kebutuhan di luar katalog = "Butuh Konsultan"). */
export const MODULES: readonly ModuleDef[] = [
  { code: "pos", name: "Kasir (POS)", desc: "Penjualan di outlet, struk, metode bayar", tier: "free", industries: ["fnb", "retail", "bengkel", "kecantikan"] },
  { code: "inventory", name: "Stok", desc: "Stok barang/bahan, mutasi, stock opname", tier: "free", industries: ["fnb", "retail", "bengkel", "distribusi", "manufaktur", "kecantikan", "lainnya"] },
  { code: "invoicing", name: "Faktur & piutang", desc: "Faktur pelanggan, pembayaran, piutang", tier: "free", industries: ALL },
  { code: "project", name: "Proyek & tugas", desc: "Proyek klien, tugas, tahapan, tenggat", tier: "free", industries: ["jasa", "lainnya"] },
  { code: "repair", name: "Order servis", desc: "Penerimaan unit, perbaikan, suku cadang", tier: "free", industries: ["bengkel"] },
  { code: "restaurant", name: "Meja & dapur", desc: "Denah meja, pesanan ke dapur, split bill", tier: "umkm", industries: ["fnb"] },
  { code: "purchase", name: "Pembelian", desc: "PO ke pemasok, penerimaan barang", tier: "umkm", industries: ["fnb", "retail", "bengkel", "distribusi", "manufaktur", "lainnya"] },
  { code: "loyalty", name: "Member & poin", desc: "Kartu member, poin, promo", tier: "umkm", industries: ["fnb", "retail", "kecantikan"] },
  { code: "sales", name: "Penjualan B2B", desc: "Penawaran, sales order, pengiriman", tier: "umkm", industries: ["retail", "jasa", "bengkel", "distribusi", "manufaktur", "lainnya"] },
  { code: "crm", name: "CRM & prospek", desc: "Pipeline prospek, aktivitas, peluang penjualan", tier: "umkm", industries: ["jasa", "distribusi", "manufaktur", "lainnya"] },
  { code: "timesheet", name: "Timesheet & tagih per jam", desc: "Catat jam kerja tim, tagih klien per jam/milestone", tier: "umkm", industries: ["jasa"] },
  { code: "manufacturing", name: "Produksi (BoM)", desc: "Bill of materials, perintah produksi, bahan baku", tier: "umkm", industries: ["manufaktur"] },
  { code: "web_profile", name: "Web profil", desc: "Situs profil bisnis dari template", tier: "umkm", industries: ALL },
  { code: "accounting", name: "Akuntansi lengkap", desc: "Jurnal, laporan keuangan, pajak", tier: "bisnis", industries: ALL },
  { code: "hr", name: "Karyawan & absensi", desc: "Data karyawan, shift, absensi", tier: "bisnis", industries: ALL },
  { code: "recipe", name: "Resep & produksi", desc: "Bill of materials, produksi dapur pusat", tier: "bisnis", industries: ["fnb"] },
  { code: "customer_app", name: "Aplikasi pelanggan", desc: "APK pelanggan dengan brand Anda", tier: "bisnis", industries: ["fnb", "retail", "kecantikan"] },
];
const MODULE_BY_CODE = new Map(MODULES.map((m) => [m.code, m]));

export function moduleName(code: string): string {
  return MODULE_BY_CODE.get(code)?.name ?? code;
}

/** Outlet maksimum per tier (Free 1, UMKM 2, Bisnis 10, lebih = Enterprise). */
export const TIER_MAX_OUTLETS: Record<BctoneTier, number | null> = { free: 1, umkm: 2, bisnis: 10, enterprise: null };

/** Paket minimum = tier tertinggi dari modul dipilih dan jumlah outlet. */
export function minimumTier(modules: readonly string[], outlets: number): BctoneTier {
  let t: BctoneTier = "free";
  for (const c of modules) {
    const m = MODULE_BY_CODE.get(c);
    if (m && tierRank(m.tier) > tierRank(t)) t = m.tier;
  }
  for (const cand of BCTONE_TIERS) {
    const max = TIER_MAX_OUTLETS[cand];
    if (tierRank(cand) >= tierRank(t) && (max === null || outlets <= max)) return cand;
  }
  return "enterprise";
}

/** Paket yang bisa dipilih di wizard: >= minimum, bukan Enterprise. Bisnis diproses lewat review (BR-02). */
export function selectableTiers(min: BctoneTier): BctoneTier[] {
  return BCTONE_TIERS.filter((t) => t !== "enterprise" && tierRank(t) >= tierRank(min));
}

/** Free/UMKM → provisioning otomatis; Bisnis/Enterprise atau kebutuhan di luar katalog → review owner. */
export function needsReview(tier: BctoneTier, extraNeeds: string | null): boolean {
  return tier === "bisnis" || tier === "enterprise" || extraNeeds !== null;
}

// ---------------------------------------------------------------------------
// Form per langkah (Zod strict; input = objek string dari formToObject)
// ---------------------------------------------------------------------------
const email = z
  .string()
  .trim()
  .toLowerCase()
  .max(EMAIL_MAX)
  .refine((v) => EMAIL_REGEX.test(v), "email");

export const startSchema = z
  .object({
    email,
    owner_name: z.string().transform((v, ctx) => {
      const n = asciiName(v);
      if (n === null) {
        ctx.addIssue({ code: "custom", message: "name" });
        return z.NEVER;
      }
      return n;
    }),
    business_name: z
      .string()
      .transform((v) => v.replace(/\s+/g, " ").trim())
      .pipe(z.string().min(2).max(100)),
    slug: z
      .string()
      .trim()
      .toLowerCase()
      .refine((v) => SLUG_REGEX.test(v) && v !== PLATFORM_SLUG, "slug"),
    terms: z.literal("on"),
  })
  .strict();

export const otpSchema = z.object({ code: z.string().trim().regex(/^[0-9]{6}$/) }).strict();

export const businessSchema = z
  .object({
    industry: z.enum(INDUSTRIES),
    outlets: z.coerce.number().int().min(1).max(500),
  })
  .strict();

/** Modul: checkbox `m_<code>` (hanya kode katalog untuk industri ini) + `extra_needs` teks bebas opsional. */
export function parseModules(raw: Record<string, string>, industry: Industry): { ok: true; modules: string[]; extra: string | null } | { ok: false } {
  const picked = new Set<string>();
  for (const [k, v] of Object.entries(raw)) {
    if (k === "extra_needs") continue;
    if (!k.startsWith("m_") || v !== "on") return { ok: false };
    const m = MODULE_BY_CODE.get(k.slice(2));
    if (!m || !m.industries.includes(industry)) return { ok: false };
    picked.add(m.code);
  }
  const extra = (raw.extra_needs ?? "").replace(/\s+/g, " ").trim();
  if (extra.length > 500 || picked.size === 0) return { ok: false };
  return { ok: true, modules: MODULES.map((m) => m.code).filter((c) => picked.has(c)), extra: extra || null };
}

export const planSchema = z.object({ tier: z.enum(["free", "umkm", "bisnis"]) }).strict();
export const consentSchema = z.object({ consent: z.enum(["allow", "deny"]) }).strict();
export const submitSchema = z.object({ confirm: z.literal("on") }).strict();

// ---------------------------------------------------------------------------
// Cookie sesi registran & OTP
// ---------------------------------------------------------------------------
export const REG_COOKIE = "bct_reg";
export const REG_COOKIE_MAX_AGE = 24 * 3600;
export const OTP_TTL_SECONDS = 600;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_PER_EMAIL_HOUR = 3;
export const START_PER_IP_HOUR = 10;
export const START_GLOBAL_HOUR = 200;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function regMac(secret: string, id: string): string {
  return createHmac("sha256", secret).update(`bctone-reg:${id}`, "utf8").digest("base64url");
}
export function signRegCookie(secret: string, id: string): string {
  return `${id}.${regMac(secret, id)}`;
}
export function verifyRegCookie(secret: string, value: string | undefined | null): string | null {
  if (!value) return null;
  const [id, mac, extra] = value.split(".");
  if (!id || !mac || extra !== undefined || !UUID_RE.test(id)) return null;
  const a = Buffer.from(regMac(secret, id));
  const b = Buffer.from(mac);
  return a.length === b.length && timingSafeEqual(a, b) ? id : null;
}

export function otpHash(salt: string, code: string): string {
  return createHash("sha256").update(`${salt}:${code}`, "utf8").digest("hex");
}
export function generateOtp(): { code: string; salt: string; hash: string } {
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const salt = randomBytes(16).toString("hex");
  return { code, salt, hash: otpHash(salt, code) };
}
export function otpMatches(salt: string, hash: string, code: string): boolean {
  const a = Buffer.from(otpHash(salt, code), "hex");
  const b = Buffer.from(hash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Hash email untuk audit (email polos tidak pernah masuk audit_logs). */
export function emailDigest(e: string): string {
  return createHash("sha256").update(e.toLowerCase(), "utf8").digest("hex").slice(0, 16);
}

export const WIZARD_STEPS = ["akun", "verifikasi", "bisnis", "modul", "paket", "privasi", "ringkasan", "selesai"] as const;
export type WizardStep = (typeof WIZARD_STEPS)[number];
export const STEP_LABEL: Record<WizardStep, string> = {
  akun: "Akun",
  verifikasi: "Verifikasi email",
  bisnis: "Bisnis",
  modul: "Modul",
  paket: "Paket & harga",
  privasi: "Privasi AI",
  ringkasan: "Ringkasan",
  selesai: "Selesai",
};
