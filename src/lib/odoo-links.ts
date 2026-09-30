import "server-only";
import { getWebEnv } from "@/env";

/** URL Odoo tenant untuk link "Buka Odoo" (DASHBOARD_ODOO_URLS, sudah divalidasi saat boot); null bila tidak ada. */
export function odooUrlFor(client: string): string | null {
  return parseOdooUrls(getWebEnv().DASHBOARD_ODOO_URLS)[client] ?? null;
}

export function parseOdooUrls(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of (raw ?? "").split(",")) {
    const i = pair.indexOf("=");
    if (i > 0) out[pair.slice(0, i)] = pair.slice(i + 1);
  }
  return out;
}
