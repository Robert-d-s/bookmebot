/**
 * The scheduling engine against real Postgres: availability, reserve,
 * cancel, reschedule, holds. Concurrency lives in tests/concurrency.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/db/prisma";
import {
  BookingStateError,
  NotFoundError,
  SlotUnavailableError,
  VersionConflictError,
  cancelBooking,
  getAvailability,
  releaseExpiredHolds,
  rescheduleBooking,
  reserveSlot,
} from "@/server/scheduling";
import { MONDAY, NOW, at, createFixture } from "../helpers/fixture";

let f: Awaited<ReturnType<typeof createFixture>>;

beforeAll(async () => {
  f = await createFixture("engine");
});
afterAll(async () => {
  await f.cleanup();
  await prisma.$disconnect();
});

const base = () => ({ businessId: f.businessId, serviceId: f.service.id, now: NOW });
const availability = (staffId?: string) =>
  getAvailability({ ...base(), staffId, from: MONDAY, to: MONDAY });
const starts = async (staffId?: string) =>
  (await availability(staffId)).map((s) => s.start.toISOString());

describe("getAvailability", () => {
  it("offers every grid slot of the working day for all eligible staff", async () => {
    const slots = await availability();
    expect(slots[0].start.toISOString()).toBe(at(9).toISOString());
    expect(slots[slots.length - 1].start.toISOString()).toBe(at(17, 30).toISOString());
    expect(slots).toHaveLength(35);
    expect(slots[0].staffIds).toHaveLength(3);
  });

  it("returns nothing on a closed day and on an override", async () => {
    const sunday = "2030-01-13";
    expect(await getAvailability({ ...base(), from: sunday, to: sunday })).toEqual([]);
    await prisma.availabilityOverride.create({
      data: { businessId: f.businessId, date: new Date("2030-01-08"), closed: true },
    });
    expect(await getAvailability({ ...base(), from: "2030-01-08", to: "2030-01-08" })).toEqual([]);
  });

  it("rejects unknown business / service", async () => {
    await expect(
      getAvailability({ ...base(), serviceId: f.customer.id, from: MONDAY, to: MONDAY }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("reserveSlot", () => {
  it("books a given staff member and takes a chair", async () => {
    const [ana] = f.staff;
    const b = await reserveSlot({
      ...base(),
      customerId: f.customer.id,
      staffId: ana.id,
      startsAt: at(10),
    });
    expect(b.status).toBe("CONFIRMED");
    expect(b.staffId).toBe(ana.id);
    expect(b.endsAt.toISOString()).toBe(at(10, 30).toISOString());
    expect(b.resources).toHaveLength(1);

    // Ana's 10:00 is gone, the slot is still offered via the other two.
    expect(await starts(ana.id)).not.toContain(at(10).toISOString());
    const slot = (await availability()).find((s) => s.start.getTime() === at(10).getTime());
    expect(slot?.staffIds).toHaveLength(2);
  });

  it("'any staff' picks the least loaded free member", async () => {
    const [ana] = f.staff;
    const b = await reserveSlot({ ...base(), customerId: f.customer.id, startsAt: at(10) });
    expect(b.staffId).not.toBe(ana.id);
  });

  it("fails with NO_RESOURCE when both chairs are taken even though a staff member is free", async () => {
    await expect(
      reserveSlot({ ...base(), customerId: f.customer.id, startsAt: at(10) }),
    ).rejects.toMatchObject({ reason: "NO_RESOURCE" });
    // ...and the generator agrees: 10:00 is no longer offered to anyone.
    expect(await starts()).not.toContain(at(10).toISOString());
  });

  it.each([
    ["OUTSIDE_HOURS", at(18)],
    ["OUTSIDE_HOURS", at(17, 45)],
    ["NOT_ON_GRID", at(11, 5)],
    ["TOO_SOON", new Date(NOW.getTime() + 30 * 60_000)],
    ["TOO_FAR", new Date("2030-06-03T07:00:00Z")],
  ])("rejects %s", async (reason, startsAt) => {
    await expect(
      reserveSlot({ ...base(), customerId: f.customer.id, startsAt }),
    ).rejects.toMatchObject({ reason });
  });

  it("rejects a staff member who does not perform the service", async () => {
    const outsider = await prisma.staff.create({ data: { businessId: f.businessId, name: "Zed" } });
    await expect(
      reserveSlot({ ...base(), customerId: f.customer.id, staffId: outsider.id, startsAt: at(11) }),
    ).rejects.toMatchObject({ reason: "STAFF_NOT_ELIGIBLE" });
  });

  it("rejects a customer from another business", async () => {
    const other = await createFixture("other");
    try {
      await expect(
        reserveSlot({ ...base(), customerId: other.customer.id, startsAt: at(11) }),
      ).rejects.toBeInstanceOf(NotFoundError);
    } finally {
      await other.cleanup();
    }
  });
});

describe("cancelBooking", () => {
  it("frees the staff member and the chair, and is idempotent", async () => {
    const b = await reserveSlot({ ...base(), customerId: f.customer.id, startsAt: at(12) });
    expect(await starts(b.staffId)).not.toContain(at(12).toISOString());

    const c = await cancelBooking({ businessId: f.businessId, bookingId: b.id, now: NOW });
    expect(c.status).toBe("CANCELLED");
    expect(c.version).toBe(2);
    expect(await starts(b.staffId)).toContain(at(12).toISOString());

    const again = await cancelBooking({ businessId: f.businessId, bookingId: b.id });
    expect(again.version).toBe(2);
  });

  it("refuses to cancel a completed booking", async () => {
    const b = await reserveSlot({ ...base(), customerId: f.customer.id, startsAt: at(13) });
    await prisma.booking.update({ where: { id: b.id }, data: { status: "COMPLETED" } });
    await expect(
      cancelBooking({ businessId: f.businessId, bookingId: b.id }),
    ).rejects.toBeInstanceOf(BookingStateError);
    await prisma.booking.update({ where: { id: b.id }, data: { status: "CANCELLED" } });
  });
});

describe("rescheduleBooking", () => {
  it("moves the booking atomically: old slot freed, new slot taken", async () => {
    const b = await reserveSlot({ ...base(), customerId: f.customer.id, startsAt: at(14) });
    const moved = await rescheduleBooking({
      businessId: f.businessId,
      bookingId: b.id,
      startsAt: at(15),
      now: NOW,
    });
    expect(moved.startsAt.toISOString()).toBe(at(15).toISOString());
    expect(moved.staffId).toBe(b.staffId);
    expect(moved.version).toBe(b.version + 1);
    expect(await starts(b.staffId)).toContain(at(14).toISOString());
    expect(await starts(b.staffId)).not.toContain(at(15).toISOString());

    const mirror = await prisma.bookingResource.findMany({ where: { bookingId: b.id } });
    expect(mirror).toHaveLength(1);
    expect(mirror[0].startsAt.toISOString()).toBe(at(15).toISOString());
  });

  it("can shift into its own footprint", async () => {
    const b = await reserveSlot({ ...base(), customerId: f.customer.id, startsAt: at(16) });
    const moved = await rescheduleBooking({
      businessId: f.businessId,
      bookingId: b.id,
      startsAt: at(16, 15),
      now: NOW,
    });
    expect(moved.startsAt.toISOString()).toBe(at(16, 15).toISOString());
  });

  it("leaves the booking untouched when the target slot is unavailable", async () => {
    const [ana, bogdan] = f.staff;
    const blocker = await reserveSlot({
      ...base(),
      customerId: f.customer.id,
      staffId: ana.id,
      startsAt: at(9),
    });
    const b = await reserveSlot({
      ...base(),
      customerId: f.customer.id,
      staffId: bogdan.id,
      startsAt: at(9, 30),
    });
    await expect(
      rescheduleBooking({
        businessId: f.businessId,
        bookingId: b.id,
        startsAt: at(9),
        staffId: ana.id,
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(SlotUnavailableError);

    const unchanged = await prisma.booking.findUniqueOrThrow({ where: { id: b.id } });
    expect(unchanged.startsAt.toISOString()).toBe(at(9, 30).toISOString());
    expect(unchanged.staffId).toBe(bogdan.id);
    expect(unchanged.version).toBe(b.version);
    await cancelBooking({ businessId: f.businessId, bookingId: blocker.id });
  });

  it("enforces the optimistic version", async () => {
    const b = await reserveSlot({ ...base(), customerId: f.customer.id, startsAt: at(17) });
    await expect(
      rescheduleBooking({
        businessId: f.businessId,
        bookingId: b.id,
        startsAt: at(17, 15),
        expectedVersion: b.version + 5,
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(VersionConflictError);
  });
});

describe("PENDING holds", () => {
  it("occupy the slot until the sweeper releases them", async () => {
    const [, , cristi] = f.staff;
    const hold = await reserveSlot({
      ...base(),
      customerId: f.customer.id,
      staffId: cristi.id,
      startsAt: at(11),
      status: "PENDING",
      holdMinutes: 10,
    });
    expect(hold.holdExpiresAt?.toISOString()).toBe(
      new Date(NOW.getTime() + 10 * 60_000).toISOString(),
    );
    expect(await starts(cristi.id)).not.toContain(at(11).toISOString());

    expect(await releaseExpiredHolds(new Date(NOW.getTime() + 5 * 60_000))).toBe(0);
    expect(await releaseExpiredHolds(new Date(NOW.getTime() + 11 * 60_000))).toBe(1);
    expect(await starts(cristi.id)).toContain(at(11).toISOString());
  });
});
