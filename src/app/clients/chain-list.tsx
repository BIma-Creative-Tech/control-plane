import Link from "next/link";
import type { ChainView } from "@/db/tenant-queries";
import { retryableOrigin } from "@/lib/tenant-onboarding";
import { StatusBadge } from "../jobs/components";
import { SubmitButton } from "@/components/submit-button";

import { retryChainStepAction } from "./actions";

const fmt = (d: Date) => d.toISOString().replace("T", " ").slice(0, 16);

/**
 * Status per langkah rantai (chain_id). Tombol "Ulangi dari langkah ini" hanya untuk superadmin, hanya rantai aksi
 * tenant/realm, dan hanya pada langkah gagal pertama (server mengulang semua cek: asal rantai, retryStepsFrom, status
 * user target, kontrak, email F1, satu admin, kuota). Rantai Users diulang lewat aksinya di /users.
 */
export function ChainList({ chains, canRetry, highlight }: { chains: ChainView[]; canRetry: boolean; highlight: string | null }) {
  if (chains.length === 0) return <p className="text-sm text-slate-500">Belum ada rantai job.</p>;
  return (
    <ul className="space-y-2">
      {chains.map((c) => {
        const firstBad = c.steps.find((s) => s.status !== "succeeded");
        const retryable =
          canRetry &&
          retryableOrigin(c.origin) &&
          firstBad !== undefined &&
          (firstBad.status === "failed" || (firstBad.status === "cancelled" && firstBad.errorCode !== "chain_aborted")) &&
          c.steps.every((s) => ["succeeded", "failed", "cancelled"].includes(s.status));
        return (
          <li key={c.chainId} className={`rounded border bg-white p-3 text-sm ${c.chainId === highlight ? "border-blue-400" : ""}`}>
            <div className="text-xs text-slate-500">
              {fmt(c.createdAt)} UTC · <span className="font-mono">{c.origin ?? "?"}</span> · {c.actor} · rantai{" "}
              <span className="font-mono">{c.chainId.slice(0, 8)}</span>
            </div>
            <ol className="mt-1 flex flex-wrap items-center gap-1">
              {c.steps.map((s, i) => (
                <li key={s.id} className="flex items-center gap-1">
                  {i > 0 ? <span aria-hidden="true">→</span> : null}
                  <Link href={`/jobs/${s.id}`} className="font-mono underline">
                    {s.type}@{s.env ?? "?"}
                    {s.dryRun ? " (dry-run)" : ""}
                  </Link>
                  <StatusBadge value={s.status} />
                  {s.errorCode ? <span className="font-mono text-xs text-red-700">{s.errorCode}</span> : null}
                  {retryable && firstBad?.id === s.id ? (
                    <form action={retryChainStepAction}>
                      <input type="hidden" name="jobId" value={s.id} />
                      <SubmitButton className="rounded border px-2 py-0.5 text-xs hover:bg-slate-100">Ulangi dari langkah ini</SubmitButton>
                    </form>
                  ) : null}
                </li>
              ))}
            </ol>
          </li>
        );
      })}
    </ul>
  );
}
