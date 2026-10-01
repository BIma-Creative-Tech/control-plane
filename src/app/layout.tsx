import type { Metadata } from "next";
import { Manrope, Syne } from "next/font/google";
import { connection } from "next/server";
import "./globals.css";

// next/font mengunduh font saat BUILD dan menyajikannya dari origin sendiri → cocok dengan CSP `font-src 'self'`.
// Pasangan font sama dengan website expomedia.id (Syne judul, Manrope isi).
const heading = Syne({ subsets: ["latin"], weight: ["600", "700"], variable: "--font-heading-face", display: "swap" });
const body = Manrope({ subsets: ["latin"], variable: "--font-body", display: "swap" });

export const metadata: Metadata = {
  title: "Control Plane",
  robots: { index: false, follow: false },
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Semua halaman dirender dinamis agar nonce CSP per-request bisa diterapkan
  // (docs guides/content-security-policy.md §Forcing dynamic rendering).
  await connection();
  return (
    <html lang="id" className={`${heading.variable} ${body.variable}`}>
      <body className="min-h-screen">{children}</body>
    </html>
  );
}
