import type { Metadata } from "next";
import { SELF_SERVE_GRACE_DAYS, SELF_SERVE_RETENTION_DAYS } from "@/lib/billing";
import { COMPANY, paymentAccountLine } from "@/lib/company";
import { LegalPage, Section } from "./legal-page";

export const metadata: Metadata = { title: `Syarat & Ketentuan ${COMPANY.product}` };

/**
 * Publik, statis (tanpa DB/sesi). Angka masa tenggang/retensi diambil dari lib/billing.ts agar tidak menyimpang dari
 * perilaku tick langganan. DRAF operasional — teks final menunggu tinjauan hukum pemilik.
 */
export default function SyaratPage() {
  return (
    <LegalPage title="Syarat & Ketentuan" other={{ href: "/privasi", label: "Kebijakan Privasi" }}>
      <p>
        Syarat ini mengatur penggunaan layanan {COMPANY.product} (ERP berbasis Odoo, Console, dan fitur pendukungnya) yang disediakan oleh{" "}
        {COMPANY.legalName} (&ldquo;kami&rdquo;), {COMPANY.city}. Dengan mengirim pendaftaran, Anda menyetujui Syarat ini dan{" "}
        <a href="/privasi" className="underline">
          Kebijakan Privasi
        </a>
        .
      </p>
      <Section n={1} title="Pendaftaran & akun">
        <p>
          Anda menjamin data pendaftaran benar dan Anda berwenang mewakili bisnis yang didaftarkan. Satu pendaftaran menghasilkan satu
          lingkungan ERP dengan alamat subdomain sendiri. Kami dapat meninjau, menunda (daftar tunggu), atau menolak pendaftaran, mis. bila
          kapasitas penuh atau kebutuhan di luar katalog.
        </p>
        <p>Anda bertanggung jawab atas kerahasiaan login, pengguna yang Anda undang, dan seluruh aktivitas di akun Anda.</p>
      </Section>
      <Section n={2} title="Paket, harga & pajak">
        <p>
          Harga mengikuti paket dan modul yang tampil saat pendaftaran. Harga belum termasuk PPN; bila berlaku, PPN dihitung 12% x DPP nilai
          lain (efektif 11% dari harga). Klien badan usaha yang memotong PPh 23 wajib menyerahkan bukti potong.
        </p>
        <p>Paket Gratis memiliki batasan modul dan kuota; kami dapat mengubah batasan paket Gratis dengan pemberitahuan.</p>
      </Section>
      <Section n={3} title="Pembayaran">
        <p>
          Tagihan terbit di Console › Tagihan. Pembayaran dengan transfer ke <strong>{paymentAccountLine()}</strong>, lalu dilaporkan di
          Console. Pembayaran diakui setelah dana kami terima. Kami tidak pernah meminta transfer ke rekening atas nama pribadi.
        </p>
      </Section>
      <Section n={4} title="Keterlambatan, penangguhan & penghapusan">
        <p>
          Tagihan yang lewat jatuh tempo berstatus menunggak. Bila belum dibayar {SELF_SERVE_GRACE_DAYS} hari setelah jatuh tempo, layanan
          ditangguhkan (login ERP ditutup, data tetap disimpan). Bila masih ditangguhkan {SELF_SERVE_RETENTION_DAYS} hari kemudian, lingkungan
          dan datanya dapat dihapus permanen. Pembayaran sebelum penghapusan memulihkan layanan.
        </p>
      </Section>
      <Section n={5} title="Data Anda">
        <p>
          Data bisnis yang Anda masukkan ke ERP tetap milik Anda. Kami memprosesnya hanya untuk menjalankan layanan, sesuai Kebijakan
          Privasi. Anda dapat meminta ekspor data selama layanan aktif atau ditangguhkan.
        </p>
      </Section>
      <Section n={6} title="Fitur AI">
        <p>
          Fitur AI bersifat bantuan; hasilnya dapat keliru dan wajib Anda periksa sebelum dipakai untuk keputusan bisnis, pajak, atau hukum.
          Jalur pemrosesan AI mengikuti pilihan privasi Anda (lihat Kebijakan Privasi).
        </p>
      </Section>
      <Section n={7} title="Penggunaan yang dilarang">
        <p>
          Dilarang memakai layanan untuk kegiatan melanggar hukum, menyimpan konten ilegal, menguji keamanan tanpa izin tertulis, atau
          mengganggu klien lain. Pelanggaran dapat berakibat penangguhan tanpa pemberitahuan lebih dulu.
        </p>
      </Section>
      <Section n={8} title="Ketersediaan & tanggung jawab">
        <p>
          Kami berupaya menjaga layanan tetap tersedia dan mencadangkan data secara berkala, tetapi tidak menjamin layanan bebas gangguan.
          Sejauh diizinkan hukum, tanggung jawab kami terbatas pada biaya langganan yang Anda bayar untuk 3 bulan terakhir.
        </p>
      </Section>
      <Section n={9} title="Perubahan & hukum yang berlaku">
        <p>
          Perubahan material atas Syarat ini kami umumkan lewat email atau Console sebelum berlaku. Syarat ini tunduk pada hukum Republik
          Indonesia.
        </p>
      </Section>
    </LegalPage>
  );
}
