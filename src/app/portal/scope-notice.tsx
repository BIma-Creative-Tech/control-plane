import type { PortalScope } from "@/lib/portal";

/** Pesan untuk sesi portal tanpa tenant aktif (belum terikat / tenant diakhiri). Tidak menampilkan data apa pun. */
export function ScopeNotice({ scope }: { scope: Exclude<PortalScope, { kind: "ok" }> }) {
  return (
    <p role="status" className="rounded border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
      {scope.kind === "terminated"
        ? "Langganan tenant Anda sudah diakhiri. Hubungi admin platform bila ini keliru."
        : "Akun Anda belum terikat ke tenant mana pun. Hubungi admin platform (tenant-admin dibuat lewat undangan)."}
    </p>
  );
}
