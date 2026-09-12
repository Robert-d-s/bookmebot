/**
 * Row-level security: the app_tenant role sees only the business named in
 * app.business_id, sees nothing without it, and the owner role (what Prisma
 * uses) is unaffected. Uses SET LOCAL inside one transaction, which is how a
 * multi-tenant deployment would scope every request.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/db/prisma";
import { createFixture } from "../helpers/fixture";

let a: Awaited<ReturnType<typeof createFixture>>;
let b: Awaited<ReturnType<typeof createFixture>>;

beforeAll(async () => {
  a = await createFixture("rls-a");
  b = await createFixture("rls-b");
});
afterAll(async () => {
  await a.cleanup();
  await b.cleanup();
  await prisma.$disconnect();
});

const asTenant = <T>(
  businessId: string | null,
  sql: (tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0]) => Promise<T>,
) =>
  prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL ROLE app_tenant`);
    if (businessId) await tx.$executeRawUnsafe(`SET LOCAL app.business_id = '${businessId}'`);
    return sql(tx);
  });

describe("app_tenant role", () => {
  it("sees only its own business's staff, customers and bookings", async () => {
    const staff = await asTenant(
      a.businessId,
      (tx) => tx.$queryRaw<{ name: string }[]>`SELECT name FROM staff ORDER BY name`,
    );
    expect(staff.map((s) => s.name)).toEqual(["Ana", "Bogdan", "Cristi"]);
    const others = await asTenant(
      a.businessId,
      (tx) =>
        tx.$queryRaw<
          { n: bigint }[]
        >`SELECT count(*)::bigint AS n FROM customers WHERE business_id = ${b.businessId}::uuid`,
    );
    expect(Number(others[0].n)).toBe(0);
    const businesses = await asTenant(
      a.businessId,
      (tx) => tx.$queryRaw<{ id: string }[]>`SELECT id FROM businesses`,
    );
    expect(businesses.map((x) => x.id)).toEqual([a.businessId]);
  });

  it("sees nothing at all without a business id", async () => {
    const rows = await asTenant(
      null,
      (tx) => tx.$queryRaw<{ n: bigint }[]>`SELECT count(*)::bigint AS n FROM staff`,
    );
    expect(Number(rows[0].n)).toBe(0);
  });

  it("cannot insert into another business", async () => {
    await expect(
      asTenant(
        a.businessId,
        (tx) =>
          tx.$executeRaw`INSERT INTO staff (id, business_id, name, created_at, updated_at) VALUES (gen_random_uuid(), ${b.businessId}::uuid, 'Intruder', now(), now())`,
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("child tables are scoped through their parent", async () => {
    const pairs = await asTenant(
      a.businessId,
      (tx) => tx.$queryRaw<{ n: bigint }[]>`SELECT count(*)::bigint AS n FROM service_staff`,
    );
    expect(Number(pairs[0].n)).toBe(3); // one service x three staff in fixture a
    const all = await prisma.serviceStaff.count({
      where: { service: { businessId: { in: [a.businessId, b.businessId] } } },
    });
    expect(all).toBe(6);
  });

  it("gets nothing from the global operational tables", async () => {
    await expect(
      asTenant(a.businessId, (tx) => tx.$queryRaw`SELECT count(*) FROM inbound_events`),
    ).rejects.toThrow(/permission denied/);
  });

  it("the owner role is unaffected", async () => {
    expect(
      await prisma.staff.count({ where: { businessId: { in: [a.businessId, b.businessId] } } }),
    ).toBe(6);
  });
});
