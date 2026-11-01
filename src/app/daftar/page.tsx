import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { loadRegistration, registrationProgress, type Registration } from "@/bctone/registration";
import { SubmitButton } from "@/components/submit-button";
import { getDb } from "@/db";
import { plans, planQuotas } from "@/db/schema";
import { getWebEnv } from "@/env";
import { computeInvoiceTax } from "@/lib/bctone-tax";
import {
  INDUSTRIES,
  INDUSTRY_LABEL,
  MODULES,
  REG_COOKIE,
  STEP_LABEL,
  TIER_LABEL,
  TIER_PLAN,
  WIZARD_STEPS,
  minimumTier,
  moduleName,
  needsReview,
  selectableTiers,
  tierRank,
  verifyRegCookie,
  type BctoneTier,
  type Industry,
  type WizardStep,
} from "@/lib/bctone-register";
import { eq } from "drizzle-orm";
import {
  registerBusinessAction,
  registerConsentAction,
  registerModulesAction,
  registerPlanAction,
  registerResendAction,
  registerStartAction,
  registerSubmitAction,
  registerVerifyAction,
} from "./actions";

/**
 * Wizard registrasi BCTOne (PUBLIK, US-01..04). Tanpa login; langkah 3+ butuh cookie registrasi terverifikasi OTP.
 * Harga dihitung server dari plans + lib/bctone-tax (BR-03). Nonaktif (404) kecuali BCTONE_REGISTER_ENABLED=1.
 */
export const dynamic = "force-dynamic";
export const metadata = { title: "Daftar BCTOne", robots: { index: false, follow: false } };

const ERR: Record<string, string> = {
  invalid: "Isian belum lengkap atau tidak valid.",
  slug: "Alamat tidak valid: 3–30 huruf kecil/angka/tanda hubung, diawali & diakhiri huruf/angka.",
  slug_taken: "Alamat itu sudah dipakai. Pilih alamat lain.",
  rate_limited: "Terlalu banyak percobaan pendaftaran. Coba lagi dalam satu jam.",
  origin: "Permintaan ditolak. Muat ulang halaman lalu coba lagi.",
  session: "Sesi pendaftaran berakhir. Silakan mulai lagi.",
  otp_wrong: "Kode salah.",
  otp_expired: "Kode kedaluwarsa. Minta kode baru.",
  otp_locked: "Terlalu banyak kode salah. Minta kode baru.",
  otp_state: "Email sudah terverifikasi.",
  resent: "Kode baru dikirim (bila batas kirim belum tercapai).",
  modules: "Pilih minimal satu modul dari daftar.",
  tier: "Paket tidak sesuai kebutuhan yang dipilih.",
  consent: "Pilih salah satu opsi privasi AI.",
  confirm: "Centang persetujuan sebelum mengirim.",
  incomplete: "Masih ada langkah yang belum lengkap.",
  state: "Pendaftaran sudah dikirim.",
  error: "Terjadi gangguan. Coba lagi beberapa saat.",
};

const input = "w-full rounded border px-3 py-2";
const btn = "rounded bg-slate-900 px-4 py-2 font-medium text-white hover:bg-slate-700";
const rupiah = (v: string | number) => `Rp${new Intl.NumberFormat("id-ID", { maximumFractionDigits: 0 }).format(Number(v))}`;

function Badge({ tier }: { tier: BctoneTier }) {
  const cls: Record<BctoneTier, string> = {
    free: "bg-green-100 text-green-800",
    umkm: "bg-sky-100 text-sky-800",
    bisnis: "bg-violet-100 text-violet-800",
    enterprise: "bg-slate-200 text-slate-800",
  };
  return <span className={`rounded px-2 py-0.5 text-xs font-medium ${cls[tier]}`}>{TIER_LABEL[tier]}</span>;
}

function Steps({ current }: { current: WizardStep }) {
  const idx = WIZARD_STEPS.indexOf(current);
  return (
    <ol className="flex flex-wrap gap-2 text-xs" aria-label="Langkah pendaftaran">
      {WIZARD_STEPS.map((s, i) => (
        <li key={s} aria-current={i === idx ? "step" : undefined} className={`rounded px-2 py-1 ${i === idx ? "bg-slate-900 text-white" : i < idx ? "bg-slate-200" : "bg-slate-100 text-slate-500"}`}>
          {i + 1}. {STEP_LABEL[s]}
        </li>
      ))}
    </ol>
  );
}

async function quoteFor(tier: BctoneTier) {
  const code = TIER_PLAN[tier];
  if (!code) return null;
  const db = getDb();
  const p = (await db.select().from(plans).where(eq(plans.code, code)).limit(1))[0];
  if (!p) return null;
  const q = await db.select().from(planQuotas).where(eq(planQuotas.planId, p.id));
  const tax = p.priceAmount ? computeInvoiceTax(p.priceAmount, { scheme: "ppn_dpp_nilai_lain", withholdPph23: false }) : null;
  return { plan: p, limits: Object.fromEntries(q.map((x) => [x.metric, x.limitValue])) as Record<string, number>, tax };
}

export default async function DaftarPage(props: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const env = getWebEnv();
  if (env.BCTONE_REGISTER_ENABLED !== "1") notFound();
  const sp = await props.searchParams;
  const e = typeof sp.e === "string" && ERR[sp.e] ? sp.e : null;
  const id = verifyRegCookie(env.AUTH_SECRET, (await cookies()).get(REG_COOKIE)?.value);
  const reg: Registration | null = id ? await loadRegistration(getDb(), id) : null;

  // Langkah ditentukan status registrasi; parameter `s` hanya boleh mundur ke langkah yang sudah diisi.
  let step: WizardStep = "akun";
  if (reg?.status === "draft") step = "verifikasi";
  else if (reg?.status === "verified") {
    const want = typeof sp.s === "string" && (WIZARD_STEPS as readonly string[]).includes(sp.s) ? (sp.s as WizardStep) : "bisnis";
    const reachable: WizardStep[] = ["bisnis"];
    if (reg.industry && reg.outlets) reachable.push("modul");
    if (reg.modules?.length) reachable.push("paket");
    if (reg.tier) reachable.push("privasi");
    if (reg.aiConsent) reachable.push("ringkasan");
    step = reachable.includes(want) ? want : reachable.at(-1)!;
  } else if (reg) step = "selesai";
  if (sp.s === "akun" && (!reg || reg.status === "draft")) step = "akun";

  return (
    <main className="mx-auto max-w-3xl space-y-6 p-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold">Daftar BCTOne</h1>
        <p className="text-sm text-slate-600">ERP & kasir untuk F&amp;B dan retail. Mulai gratis, naik paket kapan saja.</p>
        <Steps current={step} />
      </header>
      {e ? (
        <p role={e === "resent" ? "status" : "alert"} className={`rounded p-3 text-sm ${e === "resent" ? "bg-sky-50 text-sky-800" : "bg-red-50 text-red-700"}`}>
          {ERR[e]}
        </p>
      ) : null}

      {step === "akun" ? (
        <form action={registerStartAction} className="space-y-3 rounded border bg-white p-6">
          <label className="block text-sm">
            Email pemilik
            <input name="email" type="email" required autoComplete="email" className={input} defaultValue={reg?.email ?? ""} />
          </label>
          <label className="block text-sm">
            Nama Anda
            <input name="owner_name" required maxLength={100} autoComplete="name" className={input} />
          </label>
          <label className="block text-sm">
            Nama bisnis
            <input name="business_name" required minLength={2} maxLength={100} className={input} />
          </label>
          <label className="block text-sm">
            Alamat ERP
            <span className="flex items-center gap-1">
              <input name="slug" required pattern="[a-z0-9][a-z0-9-]{1,28}[a-z0-9]" className={input} placeholder="kopi-senja" />
              <span className="whitespace-nowrap text-xs text-slate-500">.erp.bimacreative.tech</span>
            </span>
          </label>
          <label className="flex gap-2 text-sm">
            <input type="checkbox" name="terms" required />
            Saya menyetujui Syarat &amp; Ketentuan dan Kebijakan Privasi BCTOne.
          </label>
          <SubmitButton className={btn}>Kirim kode verifikasi</SubmitButton>
        </form>
      ) : null}

      {step === "verifikasi" && reg ? (
        <div className="space-y-3 rounded border bg-white p-6">
          <p className="text-sm">
            Kode 6 digit dikirim ke <strong>{reg.email}</strong>. Berlaku 10 menit.
          </p>
          <form action={registerVerifyAction} className="flex gap-2">
            <input name="code" required inputMode="numeric" pattern="[0-9]{6}" maxLength={6} autoComplete="one-time-code" className={`${input} max-w-40 tracking-widest`} />
            <SubmitButton className={btn}>Verifikasi</SubmitButton>
          </form>
          <form action={registerResendAction}>
            <button type="submit" className="text-sm underline">
              Kirim ulang kode
            </button>
          </form>
          <p className="text-xs text-slate-500">
            Salah email? <a href="/daftar?s=akun" className="underline">Mulai lagi</a>.
          </p>
        </div>
      ) : null}

      {step === "bisnis" && reg ? (
        <form action={registerBusinessAction} className="space-y-3 rounded border bg-white p-6">
          <fieldset className="space-y-1 text-sm">
            <legend className="font-medium">Jenis usaha</legend>
            {INDUSTRIES.map((i) => (
              <label key={i} className="flex gap-2">
                <input type="radio" name="industry" value={i} required defaultChecked={reg.industry === i} />
                {INDUSTRY_LABEL[i]}
              </label>
            ))}
          </fieldset>
          <label className="block text-sm">
            Jumlah outlet
            <input name="outlets" type="number" min={1} max={500} required defaultValue={reg.outlets ?? 1} className={`${input} max-w-32`} />
          </label>
          <SubmitButton className={btn}>Lanjut</SubmitButton>
        </form>
      ) : null}

      {step === "modul" && reg && reg.industry ? (
        <form action={registerModulesAction} className="space-y-3 rounded border bg-white p-6">
          <p className="text-sm text-slate-600">Pilih modul yang Anda butuhkan. Label menunjukkan paket minimum.</p>
          <div className="grid gap-2 sm:grid-cols-2">
            {MODULES.filter((m) => m.industries.includes(reg.industry as Industry)).map((m) => (
              <label key={m.code} className="flex gap-2 rounded border p-3 text-sm">
                <input type="checkbox" name={`m_${m.code}`} defaultChecked={reg.modules ? reg.modules.includes(m.code) : m.tier === "free"} />
                <span>
                  <span className="font-medium">{m.name}</span> <Badge tier={m.tier} />
                  <span className="block text-xs text-slate-500">{m.desc}</span>
                </span>
              </label>
            ))}
          </div>
          <label className="block text-sm">
            Kebutuhan lain di luar daftar (opsional — akan ditinjau konsultan kami)
            <textarea name="extra_needs" maxLength={500} rows={3} className={input} defaultValue={reg.extraNeeds ?? ""} />
          </label>
          <SubmitButton className={btn}>Hitung paket</SubmitButton>
        </form>
      ) : null}

      {step === "paket" && reg && reg.modules && reg.outlets ? await PlanStep(reg) : null}

      {step === "privasi" && reg ? (
        <form action={registerConsentAction} className="space-y-3 rounded border bg-white p-6 text-sm">
          <p className="font-medium">Bagaimana fitur AI boleh memproses data Anda?</p>
          <label className="flex gap-2">
            <input type="radio" name="consent" value="allow" required defaultChecked={reg.aiConsent === "allow"} />
            <span>
              <strong>Izinkan.</strong> Prompt (sudah disamarkan: email, nomor HP, NIK) diproses Claude (Anthropic) melalui gateway BCT
              untuk hasil terbaik.
            </span>
          </label>
          <label className="flex gap-2">
            <input type="radio" name="consent" value="deny" required defaultChecked={reg.aiConsent === "deny"} />
            <span>
              <strong>Tidak izinkan.</strong> Hanya model lokal di server BCT (Indonesia). Jawaban lebih sederhana, tidak pernah dialihkan
              ke layanan pihak ketiga.
            </span>
          </label>
          <p className="text-xs text-slate-500">Tidak ada pilihan bawaan. Bisa diubah kapan saja di Console › Privasi.</p>
          <SubmitButton className={btn}>Lanjut</SubmitButton>
        </form>
      ) : null}

      {step === "ringkasan" && reg ? await SummaryStep(reg) : null}

      {step === "selesai" && reg ? await DoneStep(reg) : null}
    </main>
  );
}

async function PlanStep(reg: Registration) {
  const min = minimumTier(reg.modules!, reg.outlets!);
  const tiers = selectableTiers(min);
  const quotes = await Promise.all(tiers.map(async (t) => ({ t, q: await quoteFor(t) })));
  return (
    <form action={registerPlanAction} className="space-y-3 rounded border bg-white p-6">
      <p className="text-sm">
        Paket minimum untuk kebutuhan Anda: <Badge tier={min} />
        {min === "enterprise" ? " — jumlah outlet di atas 10 ditangani tim kami (paket Bisnis diajukan untuk ditinjau)." : null}
      </p>
      <div className="grid gap-3 sm:grid-cols-3">
        {quotes.map(({ t, q }) => (
          <label key={t} className="space-y-1 rounded border p-3 text-sm">
            <span className="flex items-center gap-2">
              <input type="radio" name="tier" value={t} required defaultChecked={reg.tier === t} />
              <Badge tier={t} />
            </span>
            {q?.tax ? (
              <span className="block">
                <span className="text-lg font-semibold">{rupiah(q.tax.amount)}</span>/bulan
                <span className="block text-xs text-slate-500">
                  + PPN {rupiah(q.tax.ppnAmount)} = {rupiah(q.tax.totalAmount)}
                </span>
              </span>
            ) : (
              <span className="block text-lg font-semibold">Gratis</span>
            )}
            {q ? (
              <span className="block text-xs text-slate-500">
                {q.limits.users ?? "∞"} user · {q.limits.outlets ?? "∞"} outlet · {q.limits.trx_per_month ? new Intl.NumberFormat("id-ID").format(q.limits.trx_per_month) : "∞"} trx/bln ·
                AI {q.limits.ai_prompts_per_day ?? "∞"}/hari
              </span>
            ) : null}
            {t === "bisnis" ? <span className="block text-xs text-violet-700">Ditinjau tim kami sebelum aktif.</span> : null}
          </label>
        ))}
      </div>
      <p className="text-xs text-slate-500">Harga belum termasuk PPN 11% (DPP nilai lain). Badan usaha dapat memotong PPh 23.</p>
      <SubmitButton className={btn}>Lanjut</SubmitButton>
    </form>
  );
}

async function SummaryStep(reg: Registration) {
  const tier = reg.tier as BctoneTier;
  const q = await quoteFor(tier);
  const review = needsReview(tier, reg.extraNeeds);
  return (
    <form action={registerSubmitAction} className="space-y-3 rounded border bg-white p-6 text-sm">
      <dl className="grid grid-cols-[10rem_1fr] gap-y-1">
        <dt className="text-slate-500">Bisnis</dt>
        <dd>
          {reg.businessName} — <span className="font-mono">{reg.slug}.erp.bimacreative.tech</span>
        </dd>
        <dt className="text-slate-500">Jenis usaha</dt>
        <dd>
          {INDUSTRY_LABEL[reg.industry as Industry]}, {reg.outlets} outlet
        </dd>
        <dt className="text-slate-500">Modul</dt>
        <dd>{reg.modules!.map(moduleName).join(", ")}</dd>
        {reg.extraNeeds ? (
          <>
            <dt className="text-slate-500">Kebutuhan lain</dt>
            <dd>{reg.extraNeeds}</dd>
          </>
        ) : null}
        <dt className="text-slate-500">Paket</dt>
        <dd>
          <Badge tier={tier} /> {q?.tax ? `${rupiah(q.tax.totalAmount)}/bulan termasuk PPN` : "Gratis"}
        </dd>
        <dt className="text-slate-500">AI</dt>
        <dd>{reg.aiConsent === "allow" ? "Izinkan (Claude)" : "Tidak izinkan (model lokal BCT)"}</dd>
      </dl>
      <p className={`rounded p-3 ${review ? "bg-violet-50 text-violet-800" : "bg-green-50 text-green-800"}`}>
        {review
          ? "Pendaftaran Anda akan ditinjau tim kami (paket Bisnis atau ada kebutuhan di luar katalog). Kami menghubungi Anda lewat email."
          : "ERP Anda disiapkan otomatis setelah dikirim (beberapa menit). Undangan login dikirim ke email Anda."}
        {tier !== "free" && !review ? " Tagihan pertama terbit di Console; pembayaran manual (transfer)." : ""}
      </p>
      <p className="text-xs text-slate-500">
        Ubah: <a href="/daftar?s=bisnis" className="underline">bisnis</a> · <a href="/daftar?s=modul" className="underline">modul</a> ·{" "}
        <a href="/daftar?s=paket" className="underline">paket</a> · <a href="/daftar?s=privasi" className="underline">privasi</a>
      </p>
      <label className="flex gap-2">
        <input type="checkbox" name="confirm" required />
        Data di atas benar dan saya berwenang mendaftarkan bisnis ini.
      </label>
      <SubmitButton className={btn} pendingText="Mengirim…">
        Kirim pendaftaran
      </SubmitButton>
      {tierRank(tier) > tierRank(minimumTier(reg.modules!, reg.outlets!)) ? (
        <p className="text-xs text-slate-500">Anda memilih paket di atas kebutuhan minimum.</p>
      ) : null}
    </form>
  );
}

async function DoneStep(reg: Registration) {
  const pr = await registrationProgress(getDb(), reg);
  const msg: Record<string, string> = {
    review: "Pendaftaran diterima dan sedang ditinjau tim kami. Kami menghubungi Anda lewat email dalam 1 hari kerja.",
    waitlist: "Kapasitas pendaftaran baru sedang penuh. Anda masuk daftar tunggu; kami mengabari lewat email begitu slot tersedia.",
    rejected: "Pendaftaran tidak dapat kami proses. Detail dikirim lewat email.",
    failed: "Penyiapan ERP mengalami kendala. Tim kami sudah diberi tahu dan akan menghubungi Anda.",
    provisioning:
      pr.total > 0 && pr.done === pr.total
        ? "ERP Anda siap. Cek email untuk undangan login."
        : `ERP Anda sedang disiapkan (${pr.done}/${pr.total || "…"} langkah). Halaman ini bisa dimuat ulang.`,
    done: "ERP Anda siap. Cek email untuk undangan login.",
  };
  return (
    <section className="space-y-2 rounded border bg-white p-6 text-sm" data-testid="register-done">
      <p>{msg[reg.status] ?? "Pendaftaran tercatat."}</p>
      {pr.host && pr.total > 0 && pr.done === pr.total ? (
        <p>
          Alamat ERP:{" "}
          <a className="font-mono underline" href={`https://${pr.host}`}>
            {pr.host}
          </a>
        </p>
      ) : null}
      {pr.failed > 0 ? <p className="text-red-700">Sebagian langkah gagal; tim kami menindaklanjuti.</p> : null}
    </section>
  );
}
