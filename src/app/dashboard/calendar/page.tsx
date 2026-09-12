import { requireUser } from "@/server/auth/session";
import { googleConfigured } from "@/server/calendar/api";
import { getConnection } from "@/server/calendar/sync";
import { getBusiness } from "@/server/dashboard/queries";
import { prisma } from "@/server/db/prisma";
import { toLocalDate } from "@/server/scheduling/time";
import { Badge, Flash, button, buttonSecondary, card, input } from "../_components/ui";
import { fmtDateTime } from "../_lib/format";
import {
  addForeignBlockAction,
  connectDemoCalendarAction,
  disconnectCalendarAction,
  removeForeignBlockAction,
  syncNowAction,
} from "./actions";

export default async function CalendarPage(props: PageProps<"/dashboard/calendar">) {
  const user = await requireUser();
  const sp = await props.searchParams;
  const [business, conn] = await Promise.all([
    getBusiness(user.businessId),
    getConnection(user.businessId),
  ]);
  const tz = business.timezone;
  const [events, blocks] = conn
    ? await Promise.all([
        prisma.calendarEvent.findMany({
          where: { connectionId: conn.id },
          orderBy: { updatedAt: "desc" },
          take: 20,
          include: { booking: { include: { customer: true, service: true } } },
        }),
        prisma.calendarBlock.findMany({
          where: { connectionId: conn.id },
          orderBy: { startsAt: "asc" },
          take: 50,
        }),
      ])
    : [[], []];

  return (
    <>
      <h1 className="text-xl font-semibold">Calendar sync</h1>
      <Flash
        ok={typeof sp.ok === "string" ? sp.ok : undefined}
        error={typeof sp.error === "string" ? sp.error : undefined}
      />

      <section className={`${card} space-y-3 text-sm`}>
        {conn ? (
          <>
            <p>
              Connected:{" "}
              <strong>
                {conn.provider === "fake" ? "demo calendar (in-memory)" : "Google Calendar"}
              </strong>
              {conn.lastPulledAt && (
                <span className="text-zinc-500">
                  {" "}
                  · last pull {fmtDateTime(conn.lastPulledAt, tz)}
                </span>
              )}
              {conn.lastError && (
                <span className="text-red-700 dark:text-red-300"> · {conn.lastError}</span>
              )}
            </p>
            <div className="flex flex-wrap gap-2">
              <form action={syncNowAction}>
                <button className={button}>Sync now</button>
              </form>
              <form action={disconnectCalendarAction}>
                <button className={buttonSecondary}>Disconnect</button>
              </form>
            </div>
          </>
        ) : (
          <>
            <p className="text-zinc-500">
              Confirmed bookings are pushed as events; time you block in the calendar becomes
              unbookable here.
            </p>
            <div className="flex flex-wrap gap-2">
              {googleConfigured() ? (
                <a className={button} href="/api/integrations/google/connect">
                  Connect Google Calendar
                </a>
              ) : (
                <span className="text-xs text-zinc-500">
                  Set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET to connect a real calendar.
                </span>
              )}
              <form action={connectDemoCalendarAction}>
                <button className={buttonSecondary}>Connect demo calendar</button>
              </form>
            </div>
          </>
        )}
      </section>

      {conn && (
        <div className="grid gap-6 lg:grid-cols-2">
          <section className={card}>
            <h2 className="mb-2 font-medium">Pushed bookings</h2>
            <table className="w-full text-sm">
              <tbody>
                {events.length === 0 && (
                  <tr>
                    <td className="text-zinc-500">
                      Nothing pushed yet. Confirm a booking or press Sync now.
                    </td>
                  </tr>
                )}
                {events.map((e) => (
                  <tr key={e.id} className="border-t align-top">
                    <td className="py-1 pr-2 whitespace-nowrap">
                      {fmtDateTime(e.booking.startsAt, tz)}
                    </td>
                    <td className="py-1 pr-2">
                      {e.booking.service.name} ·{" "}
                      {e.booking.customer.name ?? e.booking.customer.phone}
                    </td>
                    <td className="py-1 pr-2">
                      <Badge
                        status={
                          e.status === "SYNCED"
                            ? "PROCESSED"
                            : e.status === "FAILED"
                              ? "FAILED"
                              : "CANCELLED"
                        }
                      />
                    </td>
                    <td className="py-1 font-mono text-xs text-zinc-500">
                      {e.externalEventId} v{e.syncedVersion}
                      {e.lastError && <span className="block text-red-700">{e.lastError}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section className={`${card} space-y-3`}>
            <h2 className="font-medium">Blocked time pulled from the calendar</h2>
            <ul className="space-y-1 text-sm">
              {blocks.length === 0 && <li className="text-zinc-500">No blocks.</li>}
              {blocks.map((b) => (
                <li key={b.id} className="flex items-center gap-2">
                  <span>
                    {fmtDateTime(b.startsAt, tz)} – {fmtDateTime(b.endsAt, tz)}
                  </span>
                  <span className="text-zinc-500">{b.summary}</span>
                  {conn.provider === "fake" && (
                    <form action={removeForeignBlockAction} className="ml-auto">
                      <input type="hidden" name="externalEventId" value={b.externalEventId} />
                      <button className="text-xs underline">remove in calendar</button>
                    </form>
                  )}
                </li>
              ))}
            </ul>
            {conn.provider === "fake" && (
              <form
                action={addForeignBlockAction}
                className="flex flex-wrap items-end gap-2 border-t pt-3 text-sm"
              >
                <label>
                  Date
                  <input
                    type="date"
                    name="date"
                    defaultValue={toLocalDate(new Date(), tz)}
                    className={`${input} mt-1 block`}
                  />
                </label>
                <label>
                  Start
                  <input
                    type="time"
                    name="start"
                    defaultValue="12:00"
                    className={`${input} mt-1 block`}
                  />
                </label>
                <label>
                  Minutes
                  <input
                    type="number"
                    name="minutes"
                    defaultValue={60}
                    min={15}
                    step={15}
                    className={`${input} mt-1 block w-20`}
                  />
                </label>
                <label>
                  Summary
                  <input name="summary" placeholder="Dentist" className={`${input} mt-1 block`} />
                </label>
                <button className={buttonSecondary}>Block in demo calendar</button>
                <p className="basis-full text-xs text-zinc-500">
                  Simulates the owner creating an event in Google; the pull imports it and the slot
                  picker stops offering that time.
                </p>
              </form>
            )}
          </section>
        </div>
      )}
    </>
  );
}
