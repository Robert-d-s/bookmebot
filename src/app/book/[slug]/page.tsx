import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/server/db/prisma";
import { getAvailability } from "@/server/scheduling";
import { type LocalDate, addDays, toLocalDate } from "@/server/scheduling/time";
import { publicBookAction } from "./actions";

/**
 * Public booking page for customers who do not use WhatsApp. Same engine,
 * same deposit flow, no login. State lives in the URL: ?service=&date=&start=.
 */
const isDate = (s: unknown): s is LocalDate =>
  typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
const fmtTime = (d: Date, tz: string) =>
  new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: tz }).format(d);
const money = (c: number, cur: string) => `${(c / 100).toFixed(0)} ${cur}`;
const btn = "rounded border px-3 py-1.5 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800";
const input = "rounded border bg-transparent px-2 py-1 text-sm";

export default async function PublicBookPage(props: PageProps<"/book/[slug]">) {
  const { slug } = await props.params;
  const sp = await props.searchParams;
  const business = await prisma.business.findUnique({
    where: { slug },
    include: { services: { where: { active: true }, orderBy: { name: "asc" } } },
  });
  if (!business) notFound();
  const tz = business.timezone;
  const today = toLocalDate(new Date(), tz);
  const service = business.services.find((s) => s.id === sp.service);
  const date = isDate(sp.date) ? sp.date : today;
  const start = typeof sp.start === "string" && !Number.isNaN(Date.parse(sp.start)) ? sp.start : "";
  const slots = service
    ? await getAvailability({
        businessId: business.id,
        serviceId: service.id,
        from: date,
        to: date,
      })
    : [];
  const q = (over: Record<string, string>) => {
    const u = new URLSearchParams({ service: service?.id ?? "", date, ...over });
    return `/book/${slug}?${u.toString()}`;
  };

  return (
    <main className="mx-auto w-full max-w-2xl flex-1 space-y-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold">{business.name}</h1>
        <p className="text-sm text-zinc-500">Book online. Times shown in {tz}.</p>
      </header>
      {typeof sp.error === "string" && (
        <p className="rounded bg-red-50 px-3 py-2 text-sm text-red-800 dark:bg-red-950 dark:text-red-200">
          {sp.error}
        </p>
      )}

      <section className="space-y-2">
        <h2 className="font-medium">1. Service</h2>
        <div className="flex flex-wrap gap-2">
          {business.services.map((s) => (
            <Link
              key={s.id}
              href={`/book/${slug}?service=${s.id}&date=${date}`}
              className={`${btn} ${s.id === service?.id ? "ring-2 ring-zinc-500" : ""}`}
            >
              {s.name}{" "}
              <span className="text-zinc-500">
                · {s.durationMin} min · {money(s.priceCents, s.currency)}
                {s.depositCents > 0 && ` · ${money(s.depositCents, s.currency)} deposit`}
              </span>
            </Link>
          ))}
        </div>
      </section>

      {service && (
        <section className="space-y-2">
          <h2 className="font-medium">2. Day</h2>
          <div className="flex flex-wrap items-center gap-2">
            <Link href={q({ date: addDays(date, -1) })} className={btn}>
              ←
            </Link>
            <form className="contents">
              <input type="hidden" name="service" value={service.id} />
              <input type="date" name="date" defaultValue={date} min={today} className={input} />
              <button className={btn}>Go</button>
            </form>
            <Link href={q({ date: addDays(date, 1) })} className={btn}>
              →
            </Link>
          </div>
          <h2 className="font-medium">3. Time</h2>
          {slots.length === 0 && (
            <p className="text-sm text-zinc-500">Nothing free on {date}. Try another day.</p>
          )}
          <div className="flex flex-wrap gap-2">
            {slots.map((s) => {
              const iso = s.start.toISOString();
              return (
                <Link
                  key={iso}
                  href={q({ start: iso })}
                  className={`${btn} font-mono ${iso === start ? "ring-2 ring-zinc-500" : ""}`}
                >
                  {fmtTime(s.start, tz)}
                </Link>
              );
            })}
          </div>
        </section>
      )}

      {service && start && (
        <form action={publicBookAction} className="space-y-3 rounded-lg border p-4">
          <h2 className="font-medium">
            4. Your details for {service.name} on {date} at {fmtTime(new Date(start), tz)}
          </h2>
          <input type="hidden" name="slug" value={slug} />
          <input type="hidden" name="service" value={service.id} />
          <input type="hidden" name="date" value={date} />
          <input type="hidden" name="startsAt" value={start} />
          <div className="flex flex-wrap gap-3">
            <label className="text-sm">
              Name
              <input name="name" required className={`${input} mt-1 block`} />
            </label>
            <label className="text-sm">
              Phone (international)
              <input
                name="phone"
                required
                placeholder="+40721000000"
                className={`${input} mt-1 block`}
              />
            </label>
            <label className="text-sm">
              Email (optional, for the confirmation)
              <input name="email" type="email" className={`${input} mt-1 block`} />
            </label>
          </div>
          {service.depositCents > 0 && (
            <p className="text-sm text-zinc-500">
              A {money(service.depositCents, service.currency)} deposit confirms the booking
              (refunded if you cancel at least {business.refundCutoffHours}h before).
            </p>
          )}
          <button className="rounded bg-zinc-900 px-4 py-2 text-sm text-white dark:bg-zinc-100 dark:text-zinc-900">
            {service.depositCents > 0 ? "Continue to deposit" : "Book"}
          </button>
        </form>
      )}
    </main>
  );
}
