/**
 * A throwaway business for DB-backed tests: 3 staff, 2 chairs, one 30-minute
 * service everyone performs, weekly hours Mon-Sat 09:00-18:00 Bucharest time,
 * one customer. Each call creates a fresh business so test files cannot
 * interfere with each other.
 */
import { prisma } from "@/server/db/prisma";

export const TZ = "Europe/Bucharest";
export const MONDAY = "2030-01-07" as const; // a Monday
export const NOW = new Date("2030-01-06T12:00:00Z");
/** 09:00 Bucharest on the Monday, in UTC (winter, +2). */
export const OPEN = new Date("2030-01-07T07:00:00Z");
export const at = (h: number, m = 0) => new Date(Date.UTC(2030, 0, 7, h - 2, m));

export async function createFixture(tag: string) {
  const business = await prisma.business.create({
    data: {
      name: `Test ${tag}`,
      slug: `test-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      timezone: TZ,
      slotGranularityMin: 15,
      minLeadMin: 60,
      maxAdvanceDays: 60,
    },
  });
  const businessId = business.id;

  const staff = [];
  for (const name of ["Ana", "Bogdan", "Cristi"]) {
    staff.push(await prisma.staff.create({ data: { businessId, name } }));
  }
  const chairs = [];
  for (const name of ["Chair 1", "Chair 2"]) {
    chairs.push(await prisma.resource.create({ data: { businessId, name, type: "CHAIR" } }));
  }
  const service = await prisma.service.create({
    data: {
      businessId,
      name: "Cut",
      durationMin: 30,
      priceCents: 5000,
      requiredResourceType: "CHAIR",
      staff: { create: staff.map((s) => ({ staffId: s.id })) },
    },
  });
  await prisma.availabilityRule.createMany({
    data: [1, 2, 3, 4, 5, 6].map((weekday) => ({
      businessId,
      weekday,
      startMin: 9 * 60,
      endMin: 18 * 60,
    })),
  });
  const customer = await prisma.customer.create({
    data: { businessId, phone: "+40700000001", name: "Test Customer" },
  });

  return {
    businessId,
    staff,
    chairs,
    service,
    customer,
    async cleanup() {
      await prisma.booking.deleteMany({ where: { businessId } });
      await prisma.business.delete({ where: { id: businessId } });
    },
  };
}
