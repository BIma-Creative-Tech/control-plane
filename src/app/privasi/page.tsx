import type { Metadata } from "next";
import { SELF_SERVE_RETENTION_DAYS } from "@/lib/billing";
import { OTP_TTL_SECONDS, REG_COOKIE_MAX_AGE } from "@/lib/bctone-register";
import { COMPANY } from "@/lib/company";
import { LegalPage, Section } from "../syarat/legal-page";

export const metadata: Metadata = { title: `Kebijakan Privasi ${COMPANY.product}` };

/**
 * Publik, statis. Fakta teknis (lokasi server, backup, AI, masa berlaku cookie/OTP) mengikuti sistem saat ini:
 * VPS Jakarta, backup restic terenkripsi + salinan offsite Backblaze B2 (us-east), AI dua jalur (lib/ai-gateway.ts).
 * DRAF operasional (UU 27/2022 PDP) — teks final menunggu tinjauan hukum pemilik.
 */
export default function PrivasiPage() {
  return (
    <LegalPage title="Kebijakan Privasi" other={{ href: "/syarat", label: "Syarat & Ketentuan" }}>
      <p>
        {COMPANY.legalName} (&ldquo;kami&rdquo;) adalah pengendali data untuk data pendaftaran dan akun {COMPANY.product}, serta prosesor
        untuk data bisnis yang Anda simpan di ERP Anda. Kebijakan ini disusun mengacu pada UU No. 27 Tahun 2022 tentang Pelindungan Data
        Pribadi.
      </p>
      <Section n={1} title="Data yang kami kumpulkan">
        <ul className="list-disc space-y-1 pl-5">
          <li>Pendaftaran: nama pemilik, email, nama & alamat subdomain bisnis, industri, jumlah outlet, modul, paket, catatan kebutuhan.</li>
          <li>Keamanan: alamat IP saat mendaftar, kode OTP (disimpan sebagai hash, berlaku {OTP_TTL_SECONDS / 60} menit), log audit.</li>
          <li>Tagihan: faktur, laporan transfer, nomor bukti potong PPh 23.</li>
          <li>Pilihan privasi AI beserta riwayat perubahannya.</li>
          <li>Data bisnis yang Anda masukkan ke ERP (produk, transaksi, pelanggan Anda, dll.).</li>
        </ul>
      </Section>
      <Section n={2} title="Tujuan pemrosesan">
        <p>
          Menyiapkan dan menjalankan layanan, verifikasi email, penagihan dan kewajiban pajak, keamanan dan pencegahan penyalahgunaan, serta
          komunikasi layanan. Kami tidak menjual data dan tidak memakai data bisnis Anda untuk iklan.
        </p>
      </Section>
      <Section n={3} title="Lokasi penyimpanan & transfer ke luar negeri">
        <p>
          Server utama berada di Jakarta, Indonesia. Cadangan terenkripsi disalin ke penyimpanan Backblaze B2 di Amerika Serikat untuk
          pemulihan bencana; kunci enkripsi hanya kami pegang. Fitur AI dengan pilihan &ldquo;Izinkan&rdquo; mengirim prompt yang sudah
          disamarkan ke Anthropic (Claude) di luar negeri.
        </p>
      </Section>
      <Section n={4} title="Fitur AI">
        <p>
          Anda wajib memilih salah satu jalur; tanpa pilihan, fitur AI tidak berjalan. <strong>Izinkan</strong>: email, nomor HP, dan NIK
          disamarkan sebelum prompt keluar dari server kami, lalu diproses Claude (Anthropic). <strong>Tidak izinkan</strong>: hanya model lokal
          di server kami di Indonesia, tanpa pengalihan ke pihak ketiga. Pilihan dapat diubah kapan saja di Console › Privasi; setiap perubahan
          tercatat.
        </p>
      </Section>
      <Section n={5} title="Pihak yang menerima data">
        <p>
          Penyedia infrastruktur (Hostinger untuk server, Backblaze untuk cadangan terenkripsi), Anthropic hanya bila Anda memilih
          &ldquo;Izinkan&rdquo;, dan instansi berwenang bila diwajibkan hukum.
        </p>
      </Section>
      <Section n={6} title="Retensi">
        <p>
          Sesi pendaftaran berlaku {REG_COOKIE_MAX_AGE / 3600} jam. Data akun dan ERP disimpan selama berlangganan. Setelah layanan
          ditangguhkan {SELF_SERVE_RETENTION_DAYS} hari, lingkungan dapat dihapus; salinan di cadangan terhapus mengikuti rotasi cadangan
          (paling lama sekitar 13 bulan). Data tagihan disimpan sesuai kewajiban perpajakan.
        </p>
      </Section>
      <Section n={7} title="Hak Anda">
        <p>
          Anda berhak mengakses, memperbaiki, meminta salinan, menarik persetujuan, dan meminta penghapusan data pribadi, sepanjang tidak
          bertentangan dengan kewajiban hukum kami. Ajukan ke{" "}
          <a href={`mailto:${COMPANY.supportEmail}`} className="underline">
            {COMPANY.supportEmail}
          </a>
          ; kami menanggapi paling lambat 3 x 24 jam sejak permintaan lengkap.
        </p>
      </Section>
      <Section n={8} title="Keamanan & insiden">
        <p>
          Koneksi terenkripsi (HTTPS), cadangan terenkripsi, akses berbasis peran, dan log audit. Bila terjadi kegagalan pelindungan data
          pribadi, kami memberi tahu Anda dan otoritas paling lambat 3 x 24 jam sesuai UU PDP.
        </p>
      </Section>
    </LegalPage>
  );
}
