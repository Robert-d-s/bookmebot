import { verifyMagicToken } from "@/server/auth/magic";
import { magicSignInAction } from "../../login/actions";

/** Landing page of a sign-in link. One click completes it; prefetchers cannot. */
export default async function MagicPage(props: PageProps<"/auth/magic">) {
  const sp = await props.searchParams;
  const token = typeof sp.token === "string" ? sp.token : "";
  const email = verifyMagicToken(token);
  return (
    <main className="flex flex-1 items-center justify-center p-8">
      <div className="w-full max-w-sm space-y-4 rounded-lg border p-6">
        {email ? (
          <form action={magicSignInAction} className="space-y-3">
            <p className="text-sm">
              Sign in as <strong>{email}</strong>?
            </p>
            <input type="hidden" name="token" value={token} />
            <button className="w-full rounded bg-zinc-900 py-2 text-white dark:bg-zinc-100 dark:text-zinc-900">
              Continue
            </button>
          </form>
        ) : (
          <p className="text-sm">
            This sign-in link is invalid or expired.{" "}
            <a className="underline" href="/login">
              Request a new one.
            </a>
          </p>
        )}
      </div>
    </main>
  );
}
