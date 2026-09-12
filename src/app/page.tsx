export default function Home() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-4 p-8">
      <h1 className="text-3xl font-semibold tracking-tight">BookMeBot</h1>
      <p className="max-w-md text-center text-zinc-600 dark:text-zinc-400">
        WhatsApp AI receptionist for small service businesses. Owner dashboard arrives in phase 3.
      </p>
      <a className="text-sm underline" href="/api/health">
        /api/health
      </a>
    </main>
  );
}
