/**
 * Layanan portal tenant `/portal/users` (W6, ADR 0018 D9) — kanal `portal` di atas jobs/users.ts:
 * - tenant SELALU users.client_id aktor (DB), tidak pernah dari form/URL; target lewat userId diperiksa
 *   authorizeUserMutation (cakupan own: target harus tenant aktor, role client_user, bukan diri sendiri);
 * - role yang diberikan selalu `client_user` (memberi client_admin = superadmin, Fase 1);
 * - semua aturan F1 tetap (emailBindingConflict, staf platform, adopt tidak pernah, satu admin) + batas user plan
 *   (tambah/aktifkan; tanpa langganan Odoo → tidak dicek, dicatat di audit).
 */
import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { auditLogs, users } from "../db/schema";
import { emailHash, type OdooAccess } from "../lib/job-contract";
import type { ActionResultCode } from "../lib/job-list-params";
import type { Actor, SendFn } from "./service";
import { addUser, changeUserAccess, sendPasswordReset, setUserEnabled, userOutcomeCode, type UserActionOutcome, type UsersServiceInput } from "./users";

type PortalInput = Omit<UsersServiceInput, "channel">;

/** users.client_id aktor (null = belum terikat / baris tidak ada). */
export async function portalClientId(db: Db, actor: Actor): Promise<string | null> {
  if (!actor.userId) return null;
  const row = (await db.select({ clientId: users.clientId }).from(users).where(eq(users.id, actor.userId)).limit(1))[0];
  return row?.clientId ?? null;
}

export async function portalAddUser(
  db: Db,
  send: SendFn,
  input: PortalInput & { email: string; name: string | null; odoo: Readonly<Record<string, OdooAccess>> },
): Promise<UserActionOutcome> {
  const clientId = await portalClientId(db, input.actor);
  if (!clientId) {
    try {
      await db.insert(auditLogs).values({
        actorUserId: input.actor.userId,
        actor: `user:${input.actor.sub}`,
        action: "user.add",
        targetType: "user",
        result: "rejected",
        ip: input.meta.ip,
        requestId: input.meta.requestId,
        metadata: { reason: "authz", denial: "cross_tenant", channel: "portal", email_hash: emailHash(input.email) },
      });
    } catch {
      // diabaikan
    }
    return { ok: false, reason: "authz", denial: "cross_tenant" };
  }
  return addUser(db, send, { ...input, channel: "portal", clientId, cpRole: "client_user" });
}

export async function portalChangeAccess(
  db: Db,
  send: SendFn,
  input: PortalInput & { userId: string; odoo: Readonly<Record<string, OdooAccess>> },
): Promise<UserActionOutcome> {
  return changeUserAccess(db, send, { ...input, channel: "portal", cpRole: "client_user" });
}

export async function portalSetUserEnabled(
  db: Db,
  send: SendFn,
  input: PortalInput & { userId: string; enabled: boolean; odoo?: Readonly<Record<string, OdooAccess>> },
): Promise<UserActionOutcome> {
  return setUserEnabled(db, send, { ...input, channel: "portal" });
}

export async function portalPasswordReset(db: Db, send: SendFn, input: PortalInput & { userId: string }): Promise<UserActionOutcome> {
  return sendPasswordReset(db, send, { ...input, channel: "portal" });
}

/**
 * Kode umpan balik portal: `cross_tenant` (userId tenant lain) disamakan dengan `not_found` agar portal tidak menjadi
 * oracle keberadaan user tenant lain (penolakan tetap diaudit `cross_tenant`). Murni, diuji unit.
 */
export function portalOutcomeCode(o: UserActionOutcome): ActionResultCode {
  const c = userOutcomeCode(o);
  return c === "cross_tenant" ? "not_found" : c;
}
