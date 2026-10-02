/**
 * Form halaman Users (server-side Zod `.strict()`, modul murni — diuji unit). Field akses Odoo per environment
 * bernama `odoo_<environmentId>` (nilai none|user|admin); id environment diverifikasi ulang di layanan (harus milik
 * tenant dan dilayani instance ini). Field lain di luar skema → ditolak.
 */
import { z } from "zod";
import { CP_ROLE_ARGS, EMAIL_MAX, EMAIL_REGEX, NAME_MAX, ODOO_ACCESS, UUID_REGEX, asciiName, type OdooAccess } from "./job-contract";
import { formToObject } from "./job-forms";

const uuid = z.string().regex(UUID_REGEX);
const ODOO_FIELD = /^odoo_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const MAX_ENV_FIELDS = 3;

export const userFormSchemas = {
  addUser: z
    .object({
      clientId: uuid,
      email: z.string().trim().toLowerCase().max(EMAIL_MAX).regex(EMAIL_REGEX),
      name: z.string().trim().max(NAME_MAX * 2).optional(),
      cp_role: z.enum(CP_ROLE_ARGS),
    })
    .strict(),
  changeAccess: z.object({ userId: uuid, cp_role: z.enum(CP_ROLE_ARGS) }).strict(),
  enableUser: z.object({ userId: uuid }).strict(),
  disableUser: z.object({ userId: uuid, confirm: z.literal("on") }).strict(),
  passwordReset: z.object({ userId: uuid }).strict(),
  /** "Ikat ke tenant…" (F1.4): user lama client_id NULL → tenant/platform; role diverifikasi ulang di layanan. */
  adoptUser: z.object({ userId: uuid, clientId: uuid, cp_role: z.enum(CP_ROLE_ARGS) }).strict(),
  /**
   * Portal tenant (W6): TANPA clientId dan TANPA cp_role — tenant = users.client_id sesi, role = client_user (diisi
   * server). Field tambahan (clientId, cp_role, …) → ditolak `.strict()`.
   */
  portalAddUser: z
    .object({
      email: z.string().trim().toLowerCase().max(EMAIL_MAX).regex(EMAIL_REGEX),
      name: z.string().trim().max(NAME_MAX * 2).optional(),
    })
    .strict(),
  portalChangeAccess: z.object({ userId: uuid }).strict(),
} as const;

export type UserFormName = keyof typeof userFormSchemas;

export type UserFormResult<N extends UserFormName> =
  | { success: true; data: z.infer<(typeof userFormSchemas)[N]>; odoo: Record<string, OdooAccess> }
  | { success: false; issue: "invalid" | "name_invalid" };

/**
 * `opts.portal` (QA N5): kanal portal hanya boleh memberi akses Odoo `none|user` — `admin` ditolak di form (dan diulang
 * di layanan jobs/users.ts).
 */
export function parseUserForm<N extends UserFormName>(
  name: N,
  entries: Iterable<[string, FormDataEntryValue]>,
  opts: { portal?: boolean } = {},
): UserFormResult<N> {
  const obj = formToObject(entries);
  if (!obj) return { success: false, issue: "invalid" };
  const odoo: Record<string, OdooAccess> = {};
  const rest: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    const m = ODOO_FIELD.exec(k);
    if (m) {
      if (!(ODOO_ACCESS as readonly string[]).includes(v)) return { success: false, issue: "invalid" };
      if (opts.portal && v === "admin") return { success: false, issue: "invalid" };
      odoo[m[1]!] = v as OdooAccess;
    } else {
      rest[k] = v;
    }
  }
  if (Object.keys(odoo).length > MAX_ENV_FIELDS) return { success: false, issue: "invalid" };
  // Hanya form yang memuat akses Odoo boleh membawa field odoo_*.
  if (Object.keys(odoo).length > 0 && !["addUser", "changeAccess", "enableUser", "portalAddUser", "portalChangeAccess"].includes(name)) {
    return { success: false, issue: "invalid" };
  }
  const r = userFormSchemas[name].safeParse(rest);
  if (!r.success) return { success: false, issue: "invalid" };
  const data = r.data as z.infer<(typeof userFormSchemas)[N]>;
  if (name === "addUser" || name === "portalAddUser") {
    const n = (data as { name?: string }).name;
    if (n !== undefined && n !== "" && asciiName(n) === null) return { success: false, issue: "name_invalid" };
  }
  return { success: true, data, odoo };
}
