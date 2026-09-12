import { prisma } from "@/server/db/prisma";
import { localDayWindow, type LocalDate } from "@/server/scheduling/time";
import {
  type CalendarEventInput,
  type Conn,
  type ExternalEvent,
  EventNotFound,
  OUR_TAG,
  SyncTokenExpired,
  getCalendarApi,
} from "./api";

/**
 * Two-way sync.
 *   push: bookings -> external events, driven by booking.version so every
 *         write path (engine, dashboard, chat, payment webhook) is covered
 *         without hooks: anything whose version is not the synced version
 *         gets pushed by the next sweep (and right away from the hot paths).
 *   pull: foreign events -> calendar_blocks, which the engine treats as busy
 *         for everyone. Our own events are tagged and skipped (no echo loop).
 */

const ACTIVE = ["CONFIRMED", "COMPLETED", "NO_SHOW"] as const;

/** The shared (business-level) connection. */
export async function getConnection(businessId: string) {
  return prisma.calendarConnection.findFirst({ where: { businessId, staffId: null } });
}

/** Where a booking for `staffId` goes: the staff member's own calendar if connected, else the shared one. */
export async function connectionFor(businessId: string, staffId: string) {
  return (
    (await prisma.calendarConnection.findUnique({ where: { staffId } })) ??
    (await getConnection(businessId))
  );
}

export async function connectDemo(businessId: string, staffId: string | null = null) {
  const existing = staffId
    ? await prisma.calendarConnection.findUnique({ where: { staffId } })
    : await getConnection(businessId);
  const reset = {
    provider: "fake",
    accessToken: null,
    refreshToken: null,
    expiresAt: null,
    syncToken: null,
    lastError: null,
  };
  if (existing)
    return prisma.calendarConnection.update({ where: { id: existing.id }, data: reset });
  return prisma.calendarConnection.create({ data: { businessId, staffId, ...reset } });
}

export async function disconnect(businessId: string, staffId: string | null = null) {
  await prisma.calendarConnection.deleteMany({ where: { businessId, staffId } });
}

async function eventInput(bookingId: string): Promise<CalendarEventInput> {
  const b = await prisma.booking.findUniqueOrThrow({
    where: { id: bookingId },
    include: {
      service: true,
      staff: true,
      customer: true,
      business: { select: { timezone: true } },
    },
  });
  return {
    summary: `${b.service.name} · ${b.customer.name ?? b.customer.phone}`,
    description: `Staff: ${b.staff.name}\nCustomer: ${b.customer.name ?? "-"} ${b.customer.phone}\nStatus: ${b.status}\nBooking: ${b.id}`,
    start: b.startsAt,
    end: b.endsAt,
    timeZone: b.business.timezone,
    bookingId: b.id,
  };
}

export type PushResult = {
  action: "inserted" | "updated" | "deleted" | "skipped" | "failed";
  error?: string;
};

/**
 * Bring the external event for one booking in line with the booking.
 * Idempotent, and serialised per booking with an advisory lock: the
 * immediate push from a hot path and the sweep may run at the same time,
 * and without the lock both would insert.
 */
export async function pushBooking(bookingId: string): Promise<PushResult> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('calendar'), hashtext(${bookingId}))`;
      const booking = await tx.booking.findUnique({
        where: { id: bookingId },
        select: {
          id: true,
          businessId: true,
          staffId: true,
          status: true,
          version: true,
          calendarEvent: true,
        },
      });
      if (!booking) return { action: "skipped" as const };
      const conn =
        (await tx.calendarConnection.findUnique({ where: { staffId: booking.staffId } })) ??
        (await tx.calendarConnection.findFirst({
          where: { businessId: booking.businessId, staffId: null },
        }));
      if (!conn) return { action: "skipped" as const };
      const api = getCalendarApi(conn.provider);
      let mirror = booking.calendarEvent;
      const isActive = (ACTIVE as readonly string[]).includes(booking.status);

      try {
        // Moved to another staff member with their own calendar (or one was just
        // connected): take the event out of the old calendar, then insert anew.
        if (mirror && mirror.status !== "DELETED" && mirror.connectionId !== conn.id) {
          const old = await tx.calendarConnection.findUnique({
            where: { id: mirror.connectionId },
          });
          if (old)
            await getCalendarApi(old.provider)
              .remove(old, mirror.externalEventId)
              .catch(() => {});
          await tx.calendarEvent.update({ where: { id: mirror.id }, data: { status: "DELETED" } });
          mirror = { ...mirror, status: "DELETED" };
        }
        if (!isActive) {
          if (!mirror || mirror.status === "DELETED") return { action: "skipped" as const };
          await api.remove(conn, mirror.externalEventId);
          await tx.calendarEvent.update({
            where: { id: mirror.id },
            data: { status: "DELETED", syncedVersion: booking.version, lastError: null },
          });
          return { action: "deleted" as const };
        }
        const input = await eventInput(booking.id);
        if (mirror && mirror.status !== "DELETED") {
          if (mirror.syncedVersion === booking.version && mirror.status === "SYNCED")
            return { action: "skipped" as const };
          try {
            await api.update(conn, mirror.externalEventId, input);
            await tx.calendarEvent.update({
              where: { id: mirror.id },
              data: { syncedVersion: booking.version, status: "SYNCED", lastError: null },
            });
            return { action: "updated" as const };
          } catch (err) {
            if (!(err instanceof EventNotFound)) throw err;
            // Deleted on the Google side: recreate rather than lose the booking.
          }
        }
        const externalEventId = await api.insert(conn, input);
        await tx.calendarEvent.upsert({
          where: { bookingId: booking.id },
          create: {
            bookingId: booking.id,
            connectionId: conn.id,
            externalEventId,
            syncedVersion: booking.version,
          },
          update: {
            connectionId: conn.id,
            externalEventId,
            syncedVersion: booking.version,
            status: "SYNCED",
            lastError: null,
          },
        });
        return { action: "inserted" as const };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (mirror) {
          await tx.calendarEvent.update({
            where: { id: mirror.id },
            data: { status: "FAILED", lastError: message },
          });
        } else {
          await tx.calendarEvent
            .create({
              data: {
                bookingId: booking.id,
                connectionId: conn.id,
                externalEventId: "",
                syncedVersion: -1,
                status: "FAILED",
                lastError: message,
              },
            })
            .catch(() => {});
        }
        return { action: "failed" as const, error: message };
      }
    },
    { maxWait: 10_000, timeout: 30_000 },
  );
}

/** Every booking of a connected business whose mirror is missing, stale or failed. */
export async function syncDue(limit = 50) {
  const connected = await prisma.calendarConnection.findMany({ select: { businessId: true } });
  const ids = [...new Set(connected.map((c) => c.businessId))];
  if (ids.length === 0) return { pushed: 0, failed: 0, skipped: 0 };
  const due = await prisma.booking.findMany({
    where: {
      businessId: { in: ids },
      OR: [
        { status: { in: [...ACTIVE] }, calendarEvent: null },
        { calendarEvent: { status: "FAILED" } },
        { status: { in: [...ACTIVE] }, calendarEvent: { status: "DELETED" } },
      ],
    },
    select: { id: true },
    take: limit,
  });
  // Stale versions need a comparison Prisma cannot express in one filter; do it in SQL.
  const stale = await prisma.$queryRaw<{ id: string }[]>`
    SELECT b.id FROM bookings b JOIN calendar_events ce ON ce.booking_id = b.id
    WHERE ce.status = 'SYNCED' AND ce.synced_version <> b.version LIMIT ${limit}`;
  // Bookings whose mirror lives in a calendar that is no longer the right one.
  const moved = await prisma.$queryRaw<{ id: string }[]>`
    SELECT b.id FROM bookings b
    JOIN calendar_events ce ON ce.booking_id = b.id AND ce.status = 'SYNCED'
    JOIN calendar_connections cc ON cc.id = ce.connection_id
    LEFT JOIN calendar_connections own ON own.staff_id = b.staff_id
    WHERE (own.id IS NOT NULL AND own.id <> cc.id) OR (own.id IS NULL AND cc.staff_id IS NOT NULL)
    LIMIT ${limit}`;
  const all = [...new Set([...due, ...stale, ...moved].map((x) => x.id))];
  const counts = { pushed: 0, failed: 0, skipped: 0 };
  for (const id of all) {
    const r = await pushBooking(id);
    if (r.action === "failed") counts.failed += 1;
    else if (r.action === "skipped") counts.skipped += 1;
    else counts.pushed += 1;
  }
  return counts;
}

function blockInterval(e: ExternalEvent, timezone: string): { start: Date; end: Date } | null {
  if (e.start?.dateTime && e.end?.dateTime)
    return { start: new Date(e.start.dateTime), end: new Date(e.end.dateTime) };
  if (e.start?.date && e.end?.date) {
    // All-day: [start day 00:00, end day 00:00) in the business zone (end.date is exclusive).
    return {
      start: localDayWindow(e.start.date as LocalDate, timezone).start,
      end: localDayWindow(e.end.date as LocalDate, timezone).start,
    };
  }
  return null;
}

/** Import foreign events as blocks. Incremental when we hold a sync token, full otherwise. */
export async function pullBlocks(connectionId: string, now: Date = new Date()) {
  const conn = await prisma.calendarConnection.findUniqueOrThrow({
    where: { id: connectionId },
    include: { business: { select: { timezone: true, maxAdvanceDays: true } } },
  });
  const api = getCalendarApi(conn.provider);
  const c: Conn = conn;
  const window = {
    timeMin: now,
    timeMax: new Date(now.getTime() + conn.business.maxAdvanceDays * 86_400_000),
  };

  let result;
  let full = !conn.syncToken;
  try {
    result = await api.list(c, conn.syncToken ? { syncToken: conn.syncToken } : window);
  } catch (err) {
    if (!(err instanceof SyncTokenExpired)) {
      await prisma.calendarConnection.update({
        where: { id: conn.id },
        data: { lastError: err instanceof Error ? err.message : String(err) },
      });
      throw err;
    }
    full = true;
    result = await api.list(c, window);
  }

  const seen = new Set<string>();
  let upserted = 0;
  let removed = 0;
  for (const e of result.events) {
    if (e.private?.bookmebot === OUR_TAG.bookmebot) continue; // ours: never re-import
    if (e.status === "cancelled") {
      const r = await prisma.calendarBlock.deleteMany({
        where: { connectionId: conn.id, externalEventId: e.id },
      });
      removed += r.count;
      continue;
    }
    const iv = blockInterval(e, conn.business.timezone);
    if (!iv || iv.end <= iv.start) continue;
    seen.add(e.id);
    await prisma.calendarBlock.upsert({
      where: { connectionId_externalEventId: { connectionId: conn.id, externalEventId: e.id } },
      create: {
        businessId: conn.businessId,
        connectionId: conn.id,
        staffId: conn.staffId,
        externalEventId: e.id,
        startsAt: iv.start,
        endsAt: iv.end,
        summary: e.summary,
      },
      update: { startsAt: iv.start, endsAt: iv.end, summary: e.summary, staffId: conn.staffId },
    });
    upserted += 1;
  }
  if (full) {
    // A full listing is the truth for the window: drop blocks that vanished.
    const r = await prisma.calendarBlock.deleteMany({
      where: {
        connectionId: conn.id,
        externalEventId: { notIn: [...seen] },
        startsAt: { lt: window.timeMax },
        endsAt: { gt: window.timeMin },
      },
    });
    removed += r.count;
  }
  await prisma.calendarConnection.update({
    where: { id: conn.id },
    data: { syncToken: result.nextSyncToken ?? null, lastPulledAt: now, lastError: null },
  });
  return { upserted, removed, full };
}

/** For the cron tick and the dashboard's "sync now". */
export async function syncCalendars(now: Date = new Date()) {
  const push = await syncDue();
  const pulled = { upserted: 0, removed: 0, errors: 0 };
  for (const conn of await prisma.calendarConnection.findMany({ select: { id: true } })) {
    try {
      const r = await pullBlocks(conn.id, now);
      pulled.upserted += r.upserted;
      pulled.removed += r.removed;
    } catch {
      pulled.errors += 1;
    }
  }
  return { ...push, pulled };
}

/** Fire-and-forget push from hot paths; the sweep is the safety net. */
export function pushSoon(bookingId: string) {
  void pushBooking(bookingId).catch(() => {});
}
