import Link from "next/link";
import type { Session } from "next-auth";
import { Icon } from "@/components/icon";
import { can } from "@/lib/roles";
import { logoutAction } from "./actions";

const ITEM = "inline-flex min-h-9 items-center gap-1.5 rounded-lg px-2.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground";

export function Nav({ session }: { session: Session }) {
  return (
    <nav className="sticky top-0 z-20 border-b bg-card/85 backdrop-blur supports-[backdrop-filter]:bg-card/70">
      <div className="mx-auto flex max-w-[1600px] items-center gap-1 px-4 py-2.5 text-sm sm:gap-2 sm:px-6">
        <Link href="/dashboard" className="mr-2 flex items-center gap-2 font-heading text-base font-bold tracking-tight">
          <span className="grid size-8 place-items-center rounded-lg bg-primary text-xs font-bold text-primary-foreground" aria-hidden="true">CP</span>
          <span className="hidden sm:inline">Control Plane</span>
        </Link>
        <Link href="/dashboard" className={ITEM}><Icon name="category" className="size-4" />Dashboard</Link>
        {can(session.roles, "clients:list") ? <Link href="/clients" className={ITEM}><Icon name="buildings" className="size-4" />Clients</Link> : null}
        {can(session.roles, "users:view") ? <Link href="/users" className={ITEM}><Icon name="people" className="size-4" />Users</Link> : null}
        {can(session.roles, "jobs:view") ? <Link href="/jobs" className={ITEM}><Icon name="setting-4" className="size-4" />Jobs</Link> : null}
        <span className="ml-auto hidden rounded-full border px-2.5 py-1 text-xs text-muted-foreground md:inline">
          {session.roles.join(", ") || "tanpa role"}
        </span>
        <form action={logoutAction} className="ml-auto md:ml-0">
          <button type="submit" className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border px-3 font-medium transition-colors hover:bg-muted">
            <Icon name="logout-01" className="size-4" />
            <span className="hidden sm:inline">Keluar</span>
            <span className="sr-only sm:hidden">Keluar</span>
          </button>
        </form>
      </div>
    </nav>
  );
}
