/**
 * Ikon Iconsax (GRATIS, MIT — https://iconsax.io) yang dipakai control-plane. Menambah ikon: tambahkan namanya di
 * sini (nama diverifikasi terhadap node_modules/iconsax/dist/manifest.json), lalu `npm run icons`
 * → src/generated/iconsax-icons.json (di-commit; build tidak membutuhkan paket iconsax).
 */
export const ICON_NAMES = [
  // Navigasi
  "category",
  "buildings",
  "setting-4",
  "logout-01",
  "arrow-left-02",
  "arrow-right-02",
  "export-arrow-01",
  "refresh-circle",
  // Funnel & KPI
  "user-tag",
  "document-text",
  "send-2",
  "clipboard-tick",
  "shopping-cart",
  "3dcube",
  "truck-fast",
  "people",
  "receipt-2",
  "wallet-check",
  "chart-2",
  "money-recive",
  "empty-wallet",
  "danger",
  "box",
  "money-send",
  "status-up",
  "task-square",
  "tick-circle",
  "wallet-money",
  "presention-chart",
  // Tabel & filter
  "search-normal",
  "sort",
  "calendar",
  "location",
  "clock",
  "warning-2",
  // Biaya & BAST (plan infra 19)
  "percentage-square",
  "pen-tool",
  "gps",
] as const;

export const ICON_STYLES = ["linear", "bulk"] as const;

export type IconName = (typeof ICON_NAMES)[number];
export type IconStyle = (typeof ICON_STYLES)[number];
