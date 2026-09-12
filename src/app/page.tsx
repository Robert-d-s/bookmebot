import Link from "next/link";

export default function Home() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-4 p-8">
      <h1 className="text-3xl font-semibold tracking-tight">BookMeBot</h1>
      <p className="max-w-md text-center text-zinc-600 dark:text-zinc-400">
        WhatsApp AI receptionist for small service businesses.
      </p>
      <div className="flex gap-4 text-sm">
        <Link className="underline" href="/book/frizeria-demo">
          Book online (demo salon)
        </Link>
        <a className="underline" href="/login">
          Owner dashboard
        </a>
        <a className="underline" href="/api/health">
          /api/health
        </a>
      </div>
    </main>
  );
}
