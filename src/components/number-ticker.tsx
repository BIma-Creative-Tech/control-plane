/**
 * Number Ticker — adaptasi 21st.dev / Magic UI (MIT, https://21st.dev/@dillionverma/components/number-ticker),
 * pola yang sama dengan website expomedia: SERVER component yang merender NILAI AKHIR (tanpa JS / reduced motion
 * melihat angka benar); hitungan naik dijalankan <MotionEnhancer> (tween Motion 0,9 dtk).
 * Angka animasi `aria-hidden` + teks `sr-only` agar pembaca layar tidak membaca hitungan.
 */
const FMT = new Intl.NumberFormat("id-ID");

export function NumberTicker({ value, className }: { value: number; className?: string }) {
  const text = FMT.format(value);
  return (
    <>
      <span aria-hidden="true" data-ticker={value} className={`tabular-nums ${className ?? ""}`}>{text}</span>
      <span className="sr-only">{text}</span>
    </>
  );
}
