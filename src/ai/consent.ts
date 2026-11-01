/**
 * Inti pencatatan consent AI BCTOne (BR-05/06/07), dipakai BCT Admin (billing/service) dan Console tenant (portal).
 * Append-only hash-chain global, diserialkan advisory lock transaksi; cache clients.ai_consent di transaksi yang sama.
 */
import { desc, eq, sql } from "drizzle-orm";
import { aiConsentLog, clients } from "../db/schema";
import { consentHash, type AiConsent } from "../lib/ai-gateway";
import type { Tx } from "../jobs/service";

export async function writeAiConsentTx(tx: Tx, clientId: string, consent: AiConsent, actor: string, at: Date): Promise<string> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('bctone_ai_consent_chain'))`);
  const last = (await tx.select({ hash: aiConsentLog.hash }).from(aiConsentLog).orderBy(desc(aiConsentLog.id)).limit(1))[0];
  const hash = consentHash(last?.hash ?? null, clientId, consent, actor, at);
  await tx.insert(aiConsentLog).values({ clientId, consent, actor, createdAt: at, prevHash: last?.hash ?? null, hash });
  await tx.update(clients).set({ aiConsent: consent, updatedAt: sql`now()` }).where(eq(clients.id, clientId));
  return hash;
}
