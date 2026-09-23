/** Liveness (tanpa DB, tanpa data sensitif) — dipakai HEALTHCHECK Docker. */
export function GET() {
  return Response.json({ status: "ok" }, { headers: { "Cache-Control": "no-store" } });
}
