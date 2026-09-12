/**
 * Proves the database-level guards from the initial migration:
 *   1. two active bookings for the same staff cannot overlap (EXCLUDE)
 *   2. cancelling a booking releases the range
 *   3. the trigger mirrors booking ranges onto booking_resources, so the same
 *      guard holds for resources (chairs) too
 *
 * Runs against the real Postgres from docker-compose / CI. No mocks.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/db/prisma";

const at = (iso: string) => new Date(iso);

let businessId: string;
let staffA: string;
let staffB: string;
let chair1: string;
let chair2: string;
let serviceId: string;
let customerId: string;

const isExclusionViolation = (err: unknown) => /23P01|exclusion/i.test(String(err));

beforeAll(async () => {
  const business = await prisma.business.create({
    data: { name: "Constraint Test", slug: `constraint-test-${Date.now()}` },
  });
  businessId = business.id;

  const [a, b] = await Promise.all([
    prisma.staff.create({ data: { businessId, name: "A" } }),
    prisma.staff.create({ data: { businessId, name: "B" } }),
  ]);
  staffA = a.id;
  staffB = b.id;

  const [c1, c2] = await Promise.all([
    prisma.resource.create({ data: { businessId, name: "Chair 1", type: "CHAIR" } }),
    prisma.resource.create({ data: { businessId, name: "Chair 2", type: "CHAIR" } }),
  ]);
  chair1 = c1.id;
  chair2 = c2.id;

  const service = await prisma.service.create({
    data: { businessId, name: "Cut", durationMin: 30, priceCents: 1000 },
  });
  serviceId = service.id;

  const customer = await prisma.customer.create({
    data: { businessId, phone: "+40700000000" },
  });
  customerId = customer.id;
});

afterAll(async () => {
  // resources -> booking_resources is RESTRICT on purpose, so bookings go first.
  await prisma.booking.deleteMany({ where: { businessId } });
  await prisma.business.delete({ where: { id: businessId } });
  await prisma.$disconnect();
});

function booking(staffId: string, start: string, end: string, resourceId?: string) {
  return prisma.booking.create({
    data: {
      businessId,
      customerId,
      serviceId,
      staffId,
      startsAt: at(start),
      endsAt: at(end),
      resources: resourceId
        ? { create: { resourceId, startsAt: at(start), endsAt: at(end) } }
        : undefined,
    },
  });
}

describe("staff double-booking guard", () => {
  it("rejects an overlapping booking for the same staff", async () => {
    await booking(staffA, "2030-01-01T09:00:00Z", "2030-01-01T09:30:00Z");
    await expect(booking(staffA, "2030-01-01T09:15:00Z", "2030-01-01T09:45:00Z")).rejects.toSatisfy(
      isExclusionViolation,
    );
  });

  it("allows back-to-back bookings (closed-open ranges)", async () => {
    await expect(
      booking(staffA, "2030-01-01T09:30:00Z", "2030-01-01T10:00:00Z"),
    ).resolves.toBeTruthy();
  });

  it("allows the same time for a different staff member", async () => {
    await expect(
      booking(staffB, "2030-01-01T09:00:00Z", "2030-01-01T09:30:00Z"),
    ).resolves.toBeTruthy();
  });

  it("releases the range when the booking is cancelled", async () => {
    const b = await booking(staffA, "2030-01-02T09:00:00Z", "2030-01-02T09:30:00Z");
    await expect(booking(staffA, "2030-01-02T09:00:00Z", "2030-01-02T09:30:00Z")).rejects.toSatisfy(
      isExclusionViolation,
    );

    await prisma.booking.update({
      where: { id: b.id },
      data: { status: "CANCELLED", cancelledAt: new Date() },
    });

    await expect(
      booking(staffA, "2030-01-02T09:00:00Z", "2030-01-02T09:30:00Z"),
    ).resolves.toBeTruthy();
  });
});

describe("resource double-booking guard", () => {
  it("rejects two staff using the same chair at the same time", async () => {
    await booking(staffA, "2030-01-03T09:00:00Z", "2030-01-03T09:30:00Z", chair1);
    await expect(
      booking(staffB, "2030-01-03T09:10:00Z", "2030-01-03T09:40:00Z", chair1),
    ).rejects.toSatisfy(isExclusionViolation);
  });

  it("allows a different chair at the same time", async () => {
    await expect(
      booking(staffB, "2030-01-03T09:10:00Z", "2030-01-03T09:40:00Z", chair2),
    ).resolves.toBeTruthy();
  });

  it("trigger keeps booking_resources in sync when the booking moves or is cancelled", async () => {
    const b = await booking(staffA, "2030-01-04T09:00:00Z", "2030-01-04T09:30:00Z", chair1);

    // Reschedule: only the booking row is updated; the trigger moves the mirror.
    await prisma.booking.update({
      where: { id: b.id },
      data: { startsAt: at("2030-01-04T10:00:00Z"), endsAt: at("2030-01-04T10:30:00Z") },
    });
    const mirror = await prisma.bookingResource.findUniqueOrThrow({
      where: { bookingId_resourceId: { bookingId: b.id, resourceId: chair1 } },
    });
    expect(mirror.startsAt.toISOString()).toBe("2030-01-04T10:00:00.000Z");
    expect(mirror.active).toBe(true);

    // The old slot is free again, the new one is taken.
    await expect(
      booking(staffB, "2030-01-04T09:00:00Z", "2030-01-04T09:30:00Z", chair1),
    ).resolves.toBeTruthy();
    await expect(
      booking(staffB, "2030-01-04T10:00:00Z", "2030-01-04T10:30:00Z", chair1),
    ).rejects.toSatisfy(isExclusionViolation);

    // Cancel: mirror goes inactive and the chair frees up.
    await prisma.booking.update({ where: { id: b.id }, data: { status: "CANCELLED" } });
    const after = await prisma.bookingResource.findUniqueOrThrow({
      where: { bookingId_resourceId: { bookingId: b.id, resourceId: chair1 } },
    });
    expect(after.active).toBe(false);
    await expect(
      booking(staffB, "2030-01-04T10:00:00Z", "2030-01-04T10:30:00Z", chair1),
    ).resolves.toBeTruthy();
  });
});
