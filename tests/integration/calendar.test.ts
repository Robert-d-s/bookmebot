/**
 * Two-way calendar sync with the fake calendar on real Postgres: push on
 * confirm / reschedule / cancel driven by booking.version, holds pushed only
 * once paid, pulled blocks removing slots from the engine, echo-loop
 * prevention, cancelled foreign events, all-day events, and token expiry.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBooking, cancelBookingAndRefund } from "@/server/bookings";
import { fakeCalendar } from "@/server/calendar/api";
import {
  connectDemo,
  disconnect,
  getConnection,
  pullBlocks,
  pushBooking,
  syncDue,
} from "@/server/calendar/sync";
import { prisma } from "@/server/db/prisma";
import { FakeGateway, markPaid, setGateway } from "@/server/payments";
import { getAvailability, rescheduleBooking } from "@/server/scheduling";
import { MONDAY, NOW, at, createFixture } from "../helpers/fixture";

let f: Awaited<ReturnType<typeof createFixture>>;
let conn: NonNullable<Awaited<ReturnType<typeof getConnection>>>;

beforeAll(async () => {
  f = await createFixture("calendar");
  conn = await connectDemo(f.businessId);
});
afterAll(async () => {
  await disconnect(f.businessId);
  await f.cleanup();
  await prisma.$disconnect();
});

const book = (startsAt: Date) =>
  createBooking({
    businessId: f.businessId,
    serviceId: f.service.id,
    customerId: f.customer.id,
    startsAt,
    now: NOW,
    source: "API",
  });
const mirror = (bookingId: string) => prisma.calendarEvent.findUnique({ where: { bookingId } });
const starts = async () =>
  (
    await getAvailability({
      businessId: f.businessId,
      serviceId: f.service.id,
      from: MONDAY,
      to: MONDAY,
      now: NOW,
    })
  ).map((s) => s.start.toISOString());

describe("push", () => {
  it("a confirmed booking becomes one tagged external event", async () => {
    const { booking } = await book(at(9));
    expect(await pushBooking(booking.id)).toEqual({ action: "inserted" });
    const m = await mirror(booking.id);
    expect(m?.status).toBe("SYNCED");
    expect(m?.syncedVersion).toBe(booking.version);
    const ev = fakeCalendar.get(conn, m!.externalEventId)!;
    expect(ev.summary).toContain("Cut");
    expect(ev.private).toMatchObject({ bookmebot: "1", bookingId: booking.id });
    // Pushing again is a no-op.
    expect(await pushBooking(booking.id)).toEqual({ action: "skipped" });
  });

  it("a reschedule bumps the version and the sweep updates the event in place", async () => {
    const { booking } = await book(at(10));
    await pushBooking(booking.id);
    const before = (await mirror(booking.id))!.externalEventId;
    await rescheduleBooking({
      businessId: f.businessId,
      bookingId: booking.id,
      startsAt: at(10, 30),
      now: NOW,
    });
    const r = await syncDue();
    expect(r.pushed).toBeGreaterThanOrEqual(1);
    const m = await mirror(booking.id);
    expect(m?.externalEventId).toBe(before);
    expect(m?.syncedVersion).toBe(booking.version + 1);
    expect(fakeCalendar.get(conn, before)?.start?.dateTime).toBe(at(10, 30).toISOString());
  });

  it("a cancel deletes the event; an event deleted on the Google side is recreated", async () => {
    const { booking } = await book(at(11));
    await pushBooking(booking.id);
    const id = (await mirror(booking.id))!.externalEventId;
    await cancelBookingAndRefund({ businessId: f.businessId, bookingId: booking.id, now: NOW });
    await pushBooking(booking.id);
    expect((await mirror(booking.id))?.status).toBe("DELETED");
    expect(fakeCalendar.get(conn, id)?.status).toBe("cancelled");

    const { booking: b2 } = await book(at(12));
    await pushBooking(b2.id);
    const id2 = (await mirror(b2.id))!.externalEventId;
    fakeCalendar.cancelForeign(conn, id2); // owner deleted it by hand
    await rescheduleBooking({
      businessId: f.businessId,
      bookingId: b2.id,
      startsAt: at(12, 30),
      now: NOW,
    });
    expect(await pushBooking(b2.id)).toEqual({ action: "inserted" });
    expect((await mirror(b2.id))!.externalEventId).not.toBe(id2);
  });

  it("a deposit hold is not pushed until it is paid", async () => {
    const gateway = new FakeGateway();
    setGateway(gateway);
    const deposit = await prisma.service.create({
      data: {
        businessId: f.businessId,
        name: "Colour",
        durationMin: 30,
        priceCents: 20000,
        depositCents: 5000,
        requiredResourceType: "CHAIR",
        staff: { create: f.staff.map((s) => ({ staffId: s.id })) },
      },
    });
    try {
      const { booking } = await createBooking({
        businessId: f.businessId,
        serviceId: deposit.id,
        customerId: f.customer.id,
        startsAt: at(13),
        now: NOW,
        source: "API",
      });
      expect(booking.status).toBe("PENDING");
      expect(await pushBooking(booking.id)).toEqual({ action: "skipped" });
      const payment = await prisma.payment.findUniqueOrThrow({ where: { bookingId: booking.id } });
      await markPaid({
        checkoutSessionId: payment.checkoutSessionId!,
        paymentIntentId: "pi_cal",
        now: NOW,
      });
      const r = await syncDue();
      expect(r.pushed).toBeGreaterThanOrEqual(1);
      expect((await mirror(booking.id))?.status).toBe("SYNCED");
    } finally {
      setGateway(undefined);
    }
  });
});

describe("pull", () => {
  it("a foreign event becomes a block and removes slots for every staff member", async () => {
    const before = await starts();
    expect(before).toContain(at(14).toISOString());
    const id = fakeCalendar.addForeign(conn, { start: at(14), end: at(15), summary: "Dentist" });
    const r = await pullBlocks(conn.id, NOW);
    expect(r.upserted).toBeGreaterThanOrEqual(1);
    const block = await prisma.calendarBlock.findUniqueOrThrow({
      where: { connectionId_externalEventId: { connectionId: conn.id, externalEventId: id } },
    });
    expect(block.summary).toBe("Dentist");

    const after = await starts();
    expect(after).not.toContain(at(14).toISOString());
    expect(after).not.toContain(at(14, 45).toISOString()); // 14:45-15:15 overlaps the block
    expect(after).toContain(at(15).toISOString());

    // Owner deletes it in Google: the incremental pull removes the block.
    fakeCalendar.cancelForeign(conn, id);
    const r2 = await pullBlocks(conn.id, NOW);
    expect(r2.removed).toBe(1);
    expect(r2.full).toBe(false);
    expect(await starts()).toContain(at(14).toISOString());
  });

  it("never re-imports our own events (no echo loop)", async () => {
    const { booking } = await book(at(16));
    await pushBooking(booking.id);
    await pullBlocks(conn.id, NOW);
    expect(
      await prisma.calendarBlock.count({
        where: {
          connectionId: conn.id,
          externalEventId: (await mirror(booking.id))!.externalEventId,
        },
      }),
    ).toBe(0);
  });

  it("an all-day event blocks the whole local day", async () => {
    const id = fakeCalendar.addForeign(conn, {
      date: "2030-01-08",
      endDate: "2030-01-09",
      summary: "Holiday",
    });
    await pullBlocks(conn.id, NOW);
    const block = await prisma.calendarBlock.findUniqueOrThrow({
      where: { connectionId_externalEventId: { connectionId: conn.id, externalEventId: id } },
    });
    expect(block.startsAt.toISOString()).toBe("2030-01-07T22:00:00.000Z"); // 00:00 Bucharest, winter
    expect(block.endsAt.toISOString()).toBe("2030-01-08T22:00:00.000Z");
    const slots = await getAvailability({
      businessId: f.businessId,
      serviceId: f.service.id,
      from: "2030-01-08",
      to: "2030-01-08",
      now: NOW,
    });
    expect(slots).toEqual([]);
  });

  it("an expired sync token triggers a full resync that keeps state consistent", async () => {
    const id = fakeCalendar.addForeign(conn, { start: at(17), end: at(17, 30), summary: "Gym" });
    fakeCalendar.expireTokens();
    const r = await pullBlocks(conn.id, NOW);
    expect(r.full).toBe(true);
    expect(
      await prisma.calendarBlock.count({ where: { connectionId: conn.id, externalEventId: id } }),
    ).toBe(1);
    expect((await getConnection(f.businessId))?.syncToken).toBeTruthy();
  });
});
