import Link from "next/link";
import { requireUser } from "@/server/auth/session";
import { getBusiness, getSchedule } from "@/server/dashboard/queries";
import { type LocalDate, addDays, toLocalDate } from "@/server/scheduling/time";
import { Badge, buttonSecondary, card } from "./_components/ui";
import { fmtTime } from "./_lib/format";

export default async function SchedulePage(props: PageProps<"/dashboard">) {
  const user = await requireUser();
  const business = await getBusiness(user.businessId);
  const sp = await props.searchParams;
  const date = (
    typeof sp.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(sp.date)
      ? sp.date
      : toLocalDate(new Date(), business.timezone)
  ) as LocalDate;
  const { staff, bookings } = await getSchedule(user.businessId, date, business.timezone);
  const active = bookings.filter((b) => b.status !== "CANCELLED");

  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">Schedule</h1>
        <Link className={buttonSecondary} href={`/dashboard?date=${addDays(date, -1)}`}>
          ←
        </Link>
        <form className="contents">
          <input
            type="date"
            name="date"
            defaultValue={date}
            className="rounded border bg-transparent px-2 py-1 text-sm"
          />
          <button className={buttonSecondary}>Go</button>
        </form>
        <Link className={buttonSecondary} href={`/dashboard?date=${addDays(date, 1)}`}>
          →
        </Link>
        <Link className={buttonSecondary} href="/dashboard">
          Today
        </Link>
        <span className="text-sm text-zinc-500">
          {active.length} booking{active.length === 1 ? "" : "s"}, {business.timezone}
        </span>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {staff.map((s) => {
          const mine = bookings.filter((b) => b.staffId === s.id);
          return (
            <section key={s.id} className={card}>
              <h2 className="mb-2 font-medium">{s.name}</h2>
              {mine.length === 0 && <p className="text-sm text-zinc-500">Free all day.</p>}
              <ul className="space-y-1">
                {mine.map((b) => (
                  <li key={b.id}>
                    <Link
                      href={`/dashboard/bookings/${b.id}`}
                      className="flex items-center gap-2 rounded px-2 py-1 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800"
                    >
                      <span className="w-24 font-mono tabular-nums">
                        {fmtTime(b.startsAt, business.timezone)}–
                        {fmtTime(b.endsAt, business.timezone)}
                      </span>
                      <span className="flex-1 truncate">
                        {b.customer.name ?? b.customer.phone} · {b.service.name}
                        {b.resources[0] && (
                          <span className="text-zinc-500"> · {b.resources[0].resource.name}</span>
                        )}
                      </span>
                      <Badge status={b.status} />
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </>
  );
}
