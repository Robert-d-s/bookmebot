import { prisma } from "@/server/db/prisma";
import { toLocalDate } from "@/server/scheduling/time";

/** Stable per business (cacheable) and volatile (per message) prompt parts. */

export async function buildSystem(businessId: string): Promise<string> {
  const [business, services, staff, rules] = await Promise.all([
    prisma.business.findUniqueOrThrow({ where: { id: businessId } }),
    prisma.service.findMany({ where: { businessId, active: true }, orderBy: { name: "asc" } }),
    prisma.staff.findMany({ where: { businessId, active: true }, orderBy: { name: "asc" } }),
    prisma.availabilityRule.findMany({
      where: { businessId, staffId: null },
      orderBy: [{ weekday: "asc" }, { startMin: "asc" }],
    }),
  ]);
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const hhmm = (m: number) =>
    `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  const hours = days
    .map((d, i) => {
      const r = rules.filter((x) => x.weekday === i);
      return `${d} ${r.length ? r.map((x) => `${hhmm(x.startMin)}-${hhmm(x.endMin)}`).join(", ") : "closed"}`;
    })
    .join("; ");

  return [
    `You are the WhatsApp receptionist of ${business.name}, a small service business in timezone ${business.timezone}.`,
    `Services (id | name | minutes | price): ${services.map((s) => `${s.id} | ${s.name} | ${s.durationMin} | ${(s.priceCents / 100).toFixed(0)} ${s.currency}`).join("; ")}.`,
    `Staff (id | name): ${staff.map((s) => `${s.id} | ${s.name}`).join("; ")}.`,
    `Opening hours: ${hours}.`,
    "",
    "How to work:",
    "- Reply like a person on chat: short, warm, no markdown, at most a few lines. Match the customer's language (Romanian or English).",
    "- To book: identify the service and the day, call get_availability, offer 2-3 times, then propose_booking for the one they pick, then ASK them to confirm. Only call confirm_booking after they say yes in a later message.",
    "- Never say a booking is made unless confirm_booking returned a booking_id. The engine decides what is free; if a tool says a time is gone, apologise and offer others.",
    "- Cancel or reschedule only the customer's own bookings (list_my_bookings first).",
    "- Use handoff for complaints, payments questions, or anything you cannot do with these tools.",
    "- Do not invent services, prices, or hours; they are all listed above.",
  ].join("\n");
}

export async function buildContext(args: {
  businessId: string;
  customer: { id: string; name: string | null };
  timezone: string;
  now: Date;
}): Promise<string> {
  const today = toLocalDate(args.now, args.timezone);
  const weekday = new Intl.DateTimeFormat("en-GB", {
    weekday: "long",
    timeZone: args.timezone,
  }).format(args.now);
  const time = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: args.timezone,
  }).format(args.now);
  const upcoming = await prisma.booking.findMany({
    where: {
      businessId: args.businessId,
      customerId: args.customer.id,
      status: { in: ["PENDING", "CONFIRMED"] },
      startsAt: { gte: args.now },
    },
    orderBy: { startsAt: "asc" },
    take: 3,
    include: { service: { select: { name: true } } },
  });
  return [
    `today=${today} (${weekday}) time=${time} timezone=${args.timezone}`,
    `customer_name=${args.customer.name ?? "-"}`,
    `upcoming_bookings=${upcoming.length ? upcoming.map((b) => `${b.id} ${b.service.name} ${b.startsAt.toISOString()}`).join("; ") : "none"}`,
  ].join("\n");
}
