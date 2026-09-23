import type { Metadata } from "next";
import { connection } from "next/server";
import "./globals.css";

export const metadata: Metadata = {
  title: "Control Plane",
  robots: { index: false, follow: false },
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Semua halaman dirender dinamis agar nonce CSP per-request bisa diterapkan
  // (docs guides/content-security-policy.md §Forcing dynamic rendering).
  await connection();
  return (
    <html lang="id">
      <body className="min-h-screen bg-slate-50 text-slate-900 antialiased">{children}</body>
    </html>
  );
}
