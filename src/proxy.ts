/**
 * Next.js 16: `middleware.ts` → `proxy.ts` (docs 02-guides/upgrading/version-16.md §middleware to proxy),
 * runtime Node.js. Tugas: nonce + CSP + request id. Otorisasi TIDAK di sini (lihat lib/authz.ts).
 */
import { NextResponse, type NextRequest } from "next/server";
import { getWebEnv } from "@/env";
import { buildCsp, generateNonce } from "@/lib/csp";
import { logger } from "@/lib/logger";
import { isForeignOriginMutation } from "@/lib/origin";

/** AUTH_URL tervalidasi; env rusak → null (mutasi ber-Origin ditolak, fail-closed). */
function appUrl(): string | null {
  try {
    return getWebEnv().AUTH_URL;
  } catch {
    return null;
  }
}

export function proxy(request: NextRequest) {
  const nonce = generateNonce();
  const csp = buildCsp(nonce, process.env.NODE_ENV === "development");
  const requestId = crypto.randomUUID();

  // OBS-J5-02: Origin asing pada mutasi → 403 di sini (sebelum Server Action dijalankan / job dibuat),
  // bukan 500 dari pemeriksaan bawaan Next.js. Nilai Origin tidak dicatat (input penyerang).
  if (isForeignOriginMutation(request.method, request.headers.get("origin"), appUrl())) {
    logger.warn({ requestId, method: request.method, path: request.nextUrl.pathname }, "mutasi ditolak: Origin asing");
    return new NextResponse("Forbidden", {
      status: 403,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy": csp,
        "X-Request-Id": requestId,
      },
    });
  }

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("x-request-id", requestId);
  requestHeaders.set("Content-Security-Policy", csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  response.headers.set("X-Request-Id", requestId);
  return response;
}

export const config = {
  matcher: [
    {
      source: "/((?!api|_next/static|_next/image|favicon.ico).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
