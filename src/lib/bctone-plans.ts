/**
 * ADR 0019 + D-1 (owner 2026-11-01: Keycloak tetap di belakang, pengelolaan lewat form Next.js) — aturan murni paket
 * BCTOne. Diuji unit.
 */
import { addMonths, type IsoDate } from "./billing";

export const BCTONE_PLAN_PREFIX = "bctone-";

/** Paket BCTOne = plan berkode `bctone-*` → langganan otomatis lifecycle `self_serve` (bukan alur implementasi). */
export function isBctonePlanCode(code: string): boolean {
  return code.startsWith(BCTONE_PLAN_PREFIX) && code.length > BCTONE_PLAN_PREFIX.length;
}

/**
 * Langganan self-serve baru: langsung `active`, periode = [mulai, mulai + periode plan). Invoice pertama (bila plan
 * berbayar) diterbitkan untuk periode itu, jatuh tempo = tanggal mulai (bayar di muka, grace 7 hari dari ends_at
 * berlaku untuk periode berikutnya). Free (tanpa harga) = tanpa invoice.
 */
export function selfServeStart(startsAt: IsoDate, periodMonths: number): { startsAt: IsoDate; endsAt: IsoDate } {
  if (!Number.isInteger(periodMonths) || periodMonths < 1 || periodMonths > 36) throw new RangeError("periode plan tidak valid");
  return { startsAt, endsAt: addMonths(startsAt, periodMonths) };
}
