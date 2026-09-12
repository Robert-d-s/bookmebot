import { prisma } from "@/server/db/prisma";
import { localDayWindow, type LocalDate } from "@/server/scheduling/time";

/** Read models for the dashboard. Every query is scoped by businessId. */

export async function getBusiness(businessId: string) {
  return prisma.business.findUniqueOrThrow({ where: { id: businessId } });
}

export async function getSchedule(businessId: string, date: LocalDate, timezone: string) {
  const window = localDayWindow(date, timezone);
  const [staff, bookings] = await Promise.all([
    prisma.staff.findMany({ where: { businessId, active: true }, orderBy: { name: "asc" } }),
    prisma.booking.findMany({
      where: { businessId, startsAt: { gte: window.start, lt: window.end } },
      orderBy: { startsAt: "asc" },
      include: {
        customer: { select: { name: true, phone: true } },
        service: { select: { name: true } },
        resources: { include: { resource: { select: { name: true } } } },
      },
    }),
  ]);
  return { staff, bookings };
}

export async function getBooking(businessId: string, id: string) {
  return prisma.booking.findFirst({
    where: { id, businessId },
    include: {
      customer: true,
      service: true,
      staff: true,
      resources: { include: { resource: true } },
    },
  });
}

export async function getCatalog(businessId: string) {
  const [services, staff, resources] = await Promise.all([
    prisma.service.findMany({
      where: { businessId },
      orderBy: { name: "asc" },
      include: { staff: { select: { staffId: true } } },
    }),
    prisma.staff.findMany({ where: { businessId }, orderBy: { name: "asc" } }),
    prisma.resource.findMany({ where: { businessId }, orderBy: { name: "asc" } }),
  ]);
  return { services, staff, resources };
}

export async function getBusinessHours(businessId: string) {
  return prisma.availabilityRule.findMany({
    where: { businessId, staffId: null },
    orderBy: [{ weekday: "asc" }, { startMin: "asc" }],
  });
}

export async function getCustomers(businessId: string) {
  return prisma.customer.findMany({
    where: { businessId },
    orderBy: { createdAt: "desc" },
    include: {
      _count: { select: { bookings: true } },
      bookings: {
        orderBy: { startsAt: "desc" },
        take: 1,
        select: { startsAt: true, status: true },
      },
    },
  });
}
