import { formatAmount } from "@/lib/billing";

/**
 * ADR 0019: nominal invoice. Invoice berpajak (BCTOne) menampilkan DPP + PPN = total, dan jumlah transfer bila klien
 * memotong PPh 23. Invoice lama (`none`) tampil seperti sebelumnya.
 */
export function InvoiceAmount(props: {
  amount: string;
  currency: string;
  taxScheme: "none" | "ppn_dpp_nilai_lain";
  ppnAmount: string;
  pph23Amount: string;
  totalAmount: string | null;
}) {
  if (props.taxScheme === "none" || props.totalAmount === null) return <>{formatAmount(props.amount, props.currency)}</>;
  const withheld = props.pph23Amount !== "0.00" && props.pph23Amount !== "0";
  const payable = withheld ? (Number(props.totalAmount) - Number(props.pph23Amount)).toFixed(2) : null;
  return (
    <span className="inline-flex flex-col">
      <span className="font-medium">{formatAmount(props.totalAmount, props.currency)}</span>
      <span className="text-xs text-slate-500">
        DPP {formatAmount(props.amount, props.currency)} + PPN {formatAmount(props.ppnAmount, props.currency)}
      </span>
      {payable !== null && (
        <span className="text-xs text-slate-500">
          PPh 23 −{formatAmount(props.pph23Amount, props.currency)} → transfer {formatAmount(payable, props.currency)}
        </span>
      )}
    </span>
  );
}
