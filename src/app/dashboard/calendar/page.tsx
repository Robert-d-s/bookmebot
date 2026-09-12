import { requireUser } from "@/server/auth/session";
import { googleConfigured } from "@/server/calendar/api";
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

/**
 * One shared calendar per business plus optional per-staff calendars. A
 * booking goes to its staff member's calendar when connected, else to the
 * shared one; blocks from a staff calendar only make that person busy.
 */
export default async function CalendarPage(props: PageProps<"/dashboard/calendar">) {
  const user = await requireUser();
  const sp = await props.searchParams;
  const [business, staff, connections] = await Promise.all([
    getBusiness(user.businessId),
    prisma.staff.findMany({
      where: { businessId: user.businessId, active: true },
      orderBy: { name: "asc" },
    }),
    prisma.calendarConnection.findMany({ where: { businessId: user.businessId } }),
  ]);
  const tz = business.timezone;
  const connIds = connections.map((c) => c.id);
  const [events, blocks] = await Promise.all([
    prisma.calendarEvent.findMany({
      where: { connectionId: { in: connIds } },
      orderBy: { updatedAt: "desc" },
      take: 20,
      include: {
        booking: { include: { customer: true, service: true, staff: true } },
        connection: { select: { staffId: true } },
      },
    }),
    prisma.calendarBlock.findMany({
      where: { connectionId: { in: connIds } },
      orderBy: { startsAt: "asc" },
      take: 50,
      include: { staff: { select: { name: true } } },
    }),
  ]);
  const rows: { staffId: string | null; label: string }[] = [
    { staffId: null, label: "Shared business calendar" },
    ...staff.map((s) => ({ staffId: s.id, label: s.name })),
  ];
  const connOf = (staffId: string | null) => connections.find((c) => c.staffId === staffId);

  return (
    <>
      <h1 className="text-xl font-semibold">Calendar sync</h1>
      <Flash
        ok={typeof sp.ok === "string" ? sp.ok : undefined}
        error={typeof sp.error === "string" ? sp.error : undefined}
      />
      <p className="text-sm text-zinc-500">
        Confirmed bookings are pushed as events; time blocked in a calendar becomes unbookable here.
        A staff member with their own calendar gets their bookings there and only their own blocks
        apply to them.
      </p>

      <section className={`${card} overflow-x-auto`}>
        <table className="w-full text-sm">
          <thead className="text-left text-zinc-500">
            <tr>
              <th className="py-1 pr-3">Calendar</th>
              <th className="py-1 pr-3">Status</th>
              <th className="py-1"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const c = connOf(r.staffId);
              return (
                <tr key={r.staffId ?? "shared"} className="border-t">
                  <td className="py-2 pr-3">{r.label}</td>
                  <td className="py-2 pr-3">
                    {c ? (
                      <>
                        {c.provider === "fake" ? "demo (in-memory)" : "Google"}
                        {c.lastPulledAt && (
                          <span className="text-zinc-500">
                            {" "}
                            · pulled {fmtDateTime(c.lastPulledAt, tz)}
                          </span>
                        )}
                        {c.lastError && (
                          <span className="text-red-700 dark:text-red-300"> · {c.lastError}</span>
                        )}
                      </>
                    ) : (
                      <span className="text-zinc-500">not connected</span>
                    )}
                  </td>
                  <td className="py-2">
                    <div className="flex flex-wrap gap-2">
                      {c ? (
                        <form action={disconnectCalendarAction}>
                          <input type="hidden" name="staffId" value={r.staffId ?? ""} />
                          <button className={buttonSecondary}>Disconnect</button>
                        </form>
                      ) : (
                        <>
                          {r.staffId === null && googleConfigured() && (
                            <a className={button} href="/api/integrations/google/connect">
                              Connect Google
                            </a>
                          )}
                          <form action={connectDemoCalendarAction}>
                            <input type="hidden" name="staffId" value={r.staffId ?? ""} />
                            <button className={buttonSecondary}>Connect demo calendar</button>
                          </form>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!googleConfigured() && (
          <p className="mt-2 text-xs text-zinc-500">
            Set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET to connect a real Google calendar (shared
            calendar only, for now).
          </p>
        )}
        {connections.length > 0 && (
          <form action={syncNowAction} className="mt-3">
            <button className={button}>Sync now</button>
          </form>
        )}
      </section>

      {connections.length > 0 && (
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
                      <span className="block text-xs text-zinc-500">
                        {e.connection.staffId
                          ? `${e.booking.staff.name}'s calendar`
                          : "shared calendar"}
                      </span>
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
            <h2 className="font-medium">Blocked time pulled from calendars</h2>
            <ul className="space-y-1 text-sm">
              {blocks.length === 0 && <li className="text-zinc-500">No blocks.</li>}
              {blocks.map((b) => {
                const c = connections.find((x) => x.id === b.connectionId);
                return (
                  <li key={b.id} className="flex items-center gap-2">
                    <span>
                      {fmtDateTime(b.startsAt, tz)} – {fmtDateTime(b.endsAt, tz)}
                    </span>
                    <span className="text-zinc-500">
                      {b.summary} · {b.staff?.name ?? "everyone"}
                    </span>
                    {c?.provider === "fake" && (
                      <form action={removeForeignBlockAction} className="ml-auto">
                        <input type="hidden" name="connectionId" value={b.connectionId} />
                        <input type="hidden" name="externalEventId" value={b.externalEventId} />
                        <button className="text-xs underline">remove in calendar</button>
                      </form>
                    )}
                  </li>
                );
              })}
            </ul>
            {connections.some((c) => c.provider === "fake") && (
              <form
                action={addForeignBlockAction}
                className="flex flex-wrap items-end gap-2 border-t pt-3 text-sm"
              >
                <label>
                  Calendar
                  <select name="staffId" className={`${input} mt-1 block`}>
                    {rows
                      .filter((r) => connOf(r.staffId)?.provider === "fake")
                      .map((r) => (
                        <option key={r.staffId ?? "shared"} value={r.staffId ?? ""}>
                          {r.label}
                        </option>
                      ))}
                  </select>
                </label>
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
                  Simulates an event created in that calendar; the pull imports it and the slot
                  picker stops offering the time.
                </p>
              </form>
            )}
          </section>
        </div>
      )}
    </>
  );
}
