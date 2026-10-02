import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { landingPath } from "@/lib/roles";

/** Halaman awal per role (W6): staf platform → /dashboard; tenant-admin/tenant-user → /portal. */
export default async function Home() {
  const session = await auth();
  redirect(session ? landingPath(session.roles) : "/login");
}
