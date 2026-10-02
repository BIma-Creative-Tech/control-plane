import {
  ISSUE_STATE_LABEL, MODEL_LABEL, issueTone, odooRecordPath, ruleLabel, sortIssues, type DocTraceIssue,
} from "@/lib/doc-trace";
import { tanggalJam } from "@/lib/format";
import { Badge, LINK, Muted, Panel, ROW, TD, TH, rise, toneClass } from "../../ui";

/**
 * Isu link dokumen SPK (plan infra 18, modul Odoo custom_doc_trace): dokumen yang tautannya ke SPK/PO/SO putus atau
 * janggal (mis. tagihan Rp 0 ganda, PO tanpa SPK). Terbuka = perlu tindakan di Odoo; diperbaiki otomatis = info 30 hari.
 * Panel tidak tampil bila tidak ada isu.
 */
export function IssuesPanel(props: { issues: DocTraceIssue[]; odooUrl: string | null }) {
  if (props.issues.length === 0) return null;
  const issues = sortIssues(props.issues);
  const open = issues.filter((i) => i.state === "open").length;
  return (
    <Panel title="Isu link dokumen" icon="warning-2" count={issues.length} className={rise(2)}
      aside={<span className="text-xs text-muted-foreground">{open} perlu tindakan · perbaiki lewat Lacak Dokumen di Odoo</span>}>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="bg-muted/50">
            <tr><th className={TH}>Isu</th><th className={TH}>Dokumen</th><th className={TH}>Status</th><th className={TH}>Terakhir dicek</th></tr>
          </thead>
          <tbody>
            {issues.map((i) => {
              const path = odooRecordPath(i.resModel, i.resId);
              const docLabel = `${MODEL_LABEL[i.resModel] ?? i.resModel} ${i.docNo ?? `#${i.resId}`}`;
              return (
                <tr key={i.issueId} className={ROW}>
                  <td className={`max-w-md ${TD}`}>
                    <div className="font-semibold">{ruleLabel(i)}</div>
                    {i.message && i.message !== ruleLabel(i) ? <div className="mt-0.5 text-xs text-muted-foreground">{i.message}</div> : null}
                  </td>
                  <td className={TD}>
                    {props.odooUrl && path
                      ? <a href={`${props.odooUrl}${path}`} className={`${LINK} whitespace-nowrap`}>{docLabel}</a>
                      : <span className="whitespace-nowrap">{docLabel}</span>}
                  </td>
                  <td className={TD}><Badge tone={toneClass(issueTone(i))}>{ISSUE_STATE_LABEL[i.state] ?? i.state}</Badge></td>
                  <td className={`whitespace-nowrap ${TD}`}>
                    {i.state === "auto_fixed" ? <Muted>diperbaiki {tanggalJam(i.fixedAt)}</Muted> : tanggalJam(i.lastSeen)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

/** Badge "n isu link" (daftar & header detail SPK); null bila tidak ada isu terbuka. */
export function IssueBadge({ count, className }: { count: number; className?: string }) {
  if (count <= 0) return null;
  return <Badge tone={toneClass("danger")} className={className}>{count} isu link</Badge>;
}
