import type { Metadata } from "next";
import { SuspendedNotice } from "../notice";

export const metadata: Metadata = { title: "Layanan ditangguhkan", robots: { index: false, follow: false } };

/**
 * Target redirect middleware Traefik `tenant-suspended` (`https://<cp-host>/suspended/<slug>`). Publik, tanpa
 * autentikasi; parameter `slug` SENGAJA tidak dibaca (tidak ada lookup DB, tidak dipantulkan, tidak ada 404 berbeda).
 */
export default function SuspendedSlugPage() {
  return <SuspendedNotice />;
}
