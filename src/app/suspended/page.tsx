import type { Metadata } from "next";
import { SuspendedNotice } from "./notice";

export const metadata: Metadata = { title: "Layanan ditangguhkan", robots: { index: false, follow: false } };

/** Publik, tanpa autentikasi (ADR 0018 D6). */
export default function SuspendedPage() {
  return <SuspendedNotice />;
}
