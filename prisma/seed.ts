/**
 * Seed: one barbershop in Bucharest with 3 staff, 2 chairs, 5 services,
 * weekly hours, one holiday override and two customers.
 *
 * Run with `pnpm db:seed`. Idempotent: wipes and recreates the demo business.
 */
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

const MIN = (h: number, m = 0) => h * 60 + m;

async function main() {
  const slug = "frizeria-demo";

  // Bookings first: booking_resources -> resources is RESTRICT, which would
  // block the cascade from businesses -> resources. Everything else cascades.
  await prisma.booking.deleteMany({ where: { business: { slug } } });
  await prisma.business.deleteMany({ where: { slug } });

  const business = await prisma.business.create({
    data: {
      name: "Frizeria Demo",
      slug,
      timezone: "Europe/Bucharest",
      slotGranularityMin: 15,
      minLeadMin: 60,
      maxAdvanceDays: 60,
    },
  });

  const [andrei, mihai, ioana] = await Promise.all(
    ["Andrei", "Mihai", "Ioana"].map((name) =>
      prisma.staff.create({ data: { businessId: business.id, name } }),
    ),
  );

  await prisma.resource.createMany({
    data: [
      { businessId: business.id, name: "Chair 1", type: "CHAIR" },
      { businessId: business.id, name: "Chair 2", type: "CHAIR" },
    ],
  });

  const services = await Promise.all(
    [
      { name: "Haircut", durationMin: 30, priceCents: 6000 },
      { name: "Beard trim", durationMin: 20, priceCents: 4000 },
      { name: "Haircut + beard", durationMin: 50, priceCents: 9000, depositCents: 2000 },
      { name: "Kids cut", durationMin: 20, priceCents: 4000 },
      { name: "Wash & style", durationMin: 40, priceCents: 7000, bufferAfterMin: 5 },
    ].map((s) =>
      prisma.service.create({
        data: { businessId: business.id, requiredResourceType: "CHAIR", ...s },
      }),
    ),
  );

  // Everyone does everything except Ioana, who does not do kids cuts.
  const pairs = services.flatMap((service) =>
    [andrei, mihai, ioana]
      .filter((s) => !(s.id === ioana.id && service.name === "Kids cut"))
      .map((staff) => ({ serviceId: service.id, staffId: staff.id })),
  );
  await prisma.serviceStaff.createMany({ data: pairs });

  // Business hours: Mon-Fri 09:00-18:00, Sat 10:00-14:00, Sun closed.
  const businessRules = [
    ...[1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMin: MIN(9), endMin: MIN(18) })),
    { weekday: 6, startMin: MIN(10), endMin: MIN(14) },
  ];
  await prisma.availabilityRule.createMany({
    data: businessRules.map((r) => ({ businessId: business.id, ...r })),
  });

  // Ioana works Tue-Sat only, and only until 16:00 on weekdays.
  await prisma.availabilityRule.createMany({
    data: [
      ...[2, 3, 4, 5].map((weekday) => ({ weekday, startMin: MIN(9), endMin: MIN(16) })),
      { weekday: 6, startMin: MIN(10), endMin: MIN(14) },
    ].map((r) => ({ businessId: business.id, staffId: ioana.id, ...r })),
  });

  // Closed on Romania's national day.
  await prisma.availabilityOverride.create({
    data: {
      businessId: business.id,
      date: new Date("2026-12-01T00:00:00Z"),
      closed: true,
      reason: "Ziua Națională",
    },
  });

  await prisma.customer.createMany({
    data: [
      { businessId: business.id, phone: "+40721000001", name: "Ana Pop" },
      { businessId: business.id, phone: "+40721000002", name: "Dan Ionescu" },
    ],
  });

  console.log(`Seeded business "${business.name}" (${business.id})`);
  console.log(`  staff: ${[andrei, mihai, ioana].map((s) => s.name).join(", ")}`);
  console.log(`  services: ${services.map((s) => s.name).join(", ")}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
