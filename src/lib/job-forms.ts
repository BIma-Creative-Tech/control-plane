/**
 * Skema form Server Action (server-side Zod `.strict()`). Modul murni (diuji unit). Kontrak args
 * final tetap divalidasi `validateJobRequest` (job-contract.ts) di lapisan layanan.
 * Checkbox HTML: ada = "on", tidak ada = field hilang.
 */
import { z } from "zod";
import { EMAIL_REGEX, FQDN_REGEX, LOGIN_REGEX, UUID_REGEX } from "./job-contract";
import { SLUG_REGEX } from "./slug";

const uuid = z.string().regex(UUID_REGEX);
const checkbox = z
  .union([z.literal("on"), z.literal("true")])
  .optional()
  .transform((v) => v !== undefined);
const optionalHost = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .transform((v) => (v === "" ? undefined : v))
  .pipe(z.string().regex(FQDN_REGEX).optional())
  .optional();
const confirm = z.string().trim().max(30).regex(SLUG_REGEX);

export const formSchemas = {
  dbProvision: z.object({ environmentId: uuid, host: optionalHost }).strict(),
  routeRender: z.object({ environmentId: uuid, host: optionalHost }).strict(),
  routeRemove: z.object({ environmentId: uuid, confirm }).strict(),
  ssoProvision: z.object({ environmentId: uuid, dry_run: checkbox, skip_smoke: checkbox }).strict(),
  ssoRotate: z.object({ environmentId: uuid, dry_run: checkbox, confirm }).strict(),
  ssoDisable: z.object({ environmentId: uuid, dry_run: checkbox, confirm }).strict(),
  ssoUser: z
    .object({
      environmentId: uuid,
      action: z.enum(["grant", "revoke", "resend_invite"]),
      email: z.string().trim().toLowerCase().max(254).regex(EMAIL_REGEX),
      login: z
        .string()
        .trim()
        .max(254)
        .transform((v) => (v === "" ? undefined : v))
        .pipe(z.string().regex(LOGIN_REGEX).optional())
        .optional(),
      admin: checkbox,
      create_kc: checkbox,
      dry_run: checkbox,
    })
    .strict(),
  retry: z.object({ jobId: uuid }).strict(),
  createClient: z
    .object({
      slug: z.string().trim().regex(SLUG_REGEX),
      name: z.string().trim().min(1).max(200),
    })
    .strict(),
  createEnvironment: z
    .object({
      clientId: uuid,
      kind: z.enum(["prod", "demo", "staging"]),
      host: optionalHost,
    })
    .strict(),
} as const;

export type FormName = keyof typeof formSchemas;

/**
 * FormData → objek biasa. Field internal Next.js Server Action (`$ACTION_*`) dibuang; field berulang
 * atau File → ditolak (null).
 */
export function formToObject(entries: Iterable<[string, FormDataEntryValue]>): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const [k, v] of entries) {
    if (k.startsWith("$ACTION")) continue;
    if (typeof v !== "string") return null;
    if (Object.prototype.hasOwnProperty.call(out, k)) return null;
    out[k] = v;
  }
  return out;
}

export function parseForm<N extends FormName>(name: N, entries: Iterable<[string, FormDataEntryValue]>) {
  const obj = formToObject(entries);
  if (!obj) return { success: false as const };
  const r = formSchemas[name].safeParse(obj);
  return r.success ? { success: true as const, data: r.data as z.infer<(typeof formSchemas)[N]> } : { success: false as const };
}
