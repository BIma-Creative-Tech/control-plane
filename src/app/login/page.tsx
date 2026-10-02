import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { landingPath } from "@/lib/roles";
import { loginAction } from "../actions";

export default async function LoginPage(props: PageProps<"/login">) {
  const session = await auth();
  if (session) redirect(landingPath(session.roles));
  const params = await props.searchParams;
  const hasError = typeof params.error === "string";

  return (
    <main className="mx-auto mt-24 max-w-sm rounded-lg border bg-white p-8 shadow-sm">
      <h1 className="mb-6 text-xl font-semibold">Control Plane</h1>
      {hasError ? (
        <p role="alert" className="mb-4 rounded bg-red-50 p-3 text-sm text-red-700">
          Login gagal. Silakan coba lagi.
        </p>
      ) : null}
      <form action={loginAction}>
        <button type="submit" className="w-full rounded bg-slate-900 px-4 py-2 text-white hover:bg-slate-700">
          Masuk dengan SSO
        </button>
      </form>
    </main>
  );
}
