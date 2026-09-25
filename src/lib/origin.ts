/**
 * Cek Origin untuk mutasi (CLAUDE.md §3.6 CSRF). Next.js sudah membandingkan Origin vs Host untuk
 * Server Action, TETAPI request TANPA header Origin diloloskan (hanya warning — docs
 * next-config-js/serverActions.md §allowedOrigins). Di sini fail-closed: Origin wajib ada dan sama
 * persis dengan origin AUTH_URL (URL publik control plane). Modul murni (diuji unit).
 */
export function isSameOrigin(originHeader: string | null | undefined, appUrl: string): boolean {
  if (!originHeader || originHeader === "null") return false;
  let expected: string;
  let actual: string;
  try {
    expected = new URL(appUrl).origin;
    actual = new URL(originHeader).origin;
  } catch {
    return false;
  }
  return actual === expected && originHeader.replace(/\/$/, "") === actual;
}

/** `Sec-Fetch-Site` (bila dikirim browser) harus same-origin. Tidak ada header → tidak memutuskan. */
export function isFetchSiteAllowed(secFetchSite: string | null | undefined): boolean {
  if (!secFetchSite) return true;
  return secFetchSite === "same-origin";
}

const SAFE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * OBS-J5-02: mutasi (Server Action = POST ke halaman) dengan header Origin yang ADA tetapi asing/tidak sama
 * dengan AUTH_URL. Dicek di proxy.ts SEBELUM Next.js — tanpa ini Next.js membatalkan Server Action dengan
 * HTTP 500 ("Invalid Server Actions request"). Origin tidak ada → false (ditangani assertSameOrigin di
 * action → 303 `?r=origin`, perilaku lama dipertahankan).
 */
export function isForeignOriginMutation(
  method: string,
  originHeader: string | null | undefined,
  appUrl: string | null,
): boolean {
  if (SAFE_METHODS.has(method.toUpperCase())) return false;
  if (originHeader === null || originHeader === undefined || originHeader === "") return false;
  // AUTH_URL tidak tersedia/valid → fail-closed.
  return appUrl === null || !isSameOrigin(originHeader, appUrl);
}
