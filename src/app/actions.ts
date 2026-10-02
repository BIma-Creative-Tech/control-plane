"use server";

import { redirect } from "next/navigation";
import { keycloakLogoutUrl, signIn, signOut } from "@/auth";

// Server Actions: Next.js memeriksa Origin (anti-CSRF). Tidak menerima input user.
export async function loginAction(): Promise<void> {
  // "/" mengarahkan per role (staf → /dashboard, tenant → /portal; app/page.tsx).
  await signIn("keycloak", { redirectTo: "/" });
}

export async function logoutAction(): Promise<void> {
  await signOut({ redirect: false });
  redirect(keycloakLogoutUrl());
}
