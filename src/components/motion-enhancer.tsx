"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";

/**
 * Satu-satunya client component dashboard: menghitung naik angka `[data-ticker]` (<NumberTicker>) dengan spring
 * Motion yang dimuat dinamis. Hanya mengubah `nodeValue` text node yang sudah dirender React (bukan `textContent`,
 * yang mengganti node milik React). Reduced motion → tidak melakukan apa pun (angka sudah final dari server).
 * Motion menulis lewat CSSOM/DOM API, bukan atribut `style` di HTML → aman terhadap CSP `style-src` ber-nonce.
 */
export function MotionEnhancer() {
  // Dipasang di layout dashboard (tetap hidup antar halaman) → jalankan ulang tiap pindah halaman.
  const pathname = usePathname();
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const fmt = new Intl.NumberFormat("id-ID");
    const stops: (() => void)[] = [];
    let cancelled = false;
    const els = [...document.querySelectorAll<HTMLElement>("[data-ticker]:not([data-ticker-done])")];
    if (els.length === 0) return;
    void import("motion").then(({ animate }) => {
      if (cancelled) return;
      els.forEach((el, i) => {
        const node = el.firstChild;
        const to = Number(el.dataset.ticker);
        if (!(node instanceof Text) || !Number.isFinite(to) || to === 0) return;
        el.dataset.tickerDone = "";
        // Nilai terbaru dari React (filter berubah saat animasi berjalan) selalu menang atas nilai animasi.
        const latest = () => fmt.format(Number(el.dataset.ticker));
        const controls = animate(0, to, {
          type: "spring", damping: 60, stiffness: 100, delay: Math.min(i, 12) * 0.03,
          onUpdate: (v) => {
            if (el.dataset.ticker !== String(to)) { controls.stop(); node.nodeValue = latest(); return; }
            node.nodeValue = fmt.format(Math.round(v));
          },
          onComplete: () => { node.nodeValue = latest(); },
        });
        stops.push(() => { controls.stop(); node.nodeValue = latest(); });
      });
    });
    return () => {
      cancelled = true;
      stops.forEach((s) => s());
    };
  }, [pathname]);
  return null;
}
