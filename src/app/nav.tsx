import Link from "next/link";
import type { Session } from "next-auth";
import { can } from "@/lib/roles";
import { logoutAction } from "./actions";

export function Nav({ session }: { session: Session }) {
  return (
    <nav className="flex items-center gap-4 border-b bg-white px-6 py-3 text-sm">
      <Link href="/dashboard" className="font-semibold">
        Control Plane
      </Link>
      {can(session.roles, "clients:list") ? <Link href="/clients">Clients</Link> : null}
      <span className="ml-auto text-slate-500">{session.roles.join(", ") || "tanpa role"}</span>
      <form action={logoutAction}>
        <button type="submit" className="rounded border px-3 py-1 hover:bg-slate-100">
          Keluar
        </button>
      </form>
    </nav>
  );
}
