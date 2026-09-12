import { emailConfigured } from "@/server/email";
import { loginAction, magicLinkAction } from "./actions";

export default async function LoginPage(props: PageProps<"/login">) {
  const { error, sent } = await props.searchParams;
  return (
    <main className="flex flex-1 flex-col items-center justify-center p-8">
      <form action={loginAction} className="w-full max-w-sm space-y-4 rounded-lg border p-6">
        <h1 className="text-xl font-semibold">BookMeBot dashboard</h1>
        {error === "expired" && (
          <p className="text-sm text-red-600">
            That sign-in link is invalid or expired. Request a new one.
          </p>
        )}
        {error && error !== "expired" && (
          <p className="text-sm text-red-600">Wrong email or password.</p>
        )}
        {sent && (
          <p className="text-sm text-emerald-700">
            If that address has an account, a sign-in link is on its way
            {emailConfigured() ? "" : " (check the server log: no RESEND_API_KEY set)"}.
          </p>
        )}
        <label className="block text-sm">
          Email
          <input
            name="email"
            type="email"
            required
            autoComplete="username"
            defaultValue="owner@frizeria.demo"
            className="mt-1 w-full rounded border px-2 py-1"
          />
        </label>
        <label className="block text-sm">
          Password
          <input
            name="password"
            type="password"
            required
            autoComplete="current-password"
            className="mt-1 w-full rounded border px-2 py-1"
          />
        </label>
        <button className="w-full rounded bg-zinc-900 py-2 text-white dark:bg-zinc-100 dark:text-zinc-900">
          Sign in
        </button>
        <p className="text-xs text-zinc-500">Seed login: owner@frizeria.demo / demo-password</p>
      </form>
      <form
        action={magicLinkAction}
        className="mt-4 w-full max-w-sm space-y-2 rounded-lg border p-6 text-sm"
      >
        <p className="font-medium">Or sign in by email link</p>
        <input
          name="email"
          type="email"
          required
          placeholder="owner@frizeria.demo"
          className="w-full rounded border px-2 py-1"
        />
        <button className="w-full rounded border py-2">Email me a link</button>
      </form>
    </main>
  );
}
