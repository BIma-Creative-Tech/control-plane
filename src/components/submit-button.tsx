"use client";

import { useFormStatus } from "react-dom";

/**
 * Tombol submit form server action yang menonaktifkan diri selama aksi berjalan (cegah submit ganda — onboarding/registrasi
 * tenant dan "Ulangi dari langkah ini" pernah terkirim 2× karena klik ganda, 2026-10-03/04). Server tetap idempoten.
 */
export function SubmitButton({
  children,
  className,
  pendingText = "Memproses…",
}: {
  children: React.ReactNode;
  className?: string;
  pendingText?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} aria-disabled={pending} className={`${className ?? ""} disabled:cursor-wait disabled:opacity-60`}>
      {pending ? pendingText : children}
    </button>
  );
}
