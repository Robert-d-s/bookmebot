/**
 * The whole point of the engine: N requests race for one slot, exactly the
 * right number win, and nobody gets a double booking.
 *
 * Runs against real Postgres with real parallel transactions. The advisory
 * lock in reserveSlot serialises the check-then-insert, so losers see the
 * winner's row and fail the engine's own check (SlotUnavailableError). The
 * exclusion constraint would catch anything that slipped past the lock
 * (SlotTakenError); a healthy run has zero of those.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/db/prisma";
import { SlotTakenError, SlotUnavailableError, reserveSlot } from "@/server/scheduling";
import { NOW, at, createFixture } from "../helpers/fixture";

const N = 25;
let f: Awaited<ReturnType<typeof createFixture>>;

beforeAll(async () => {
  f = await createFixture("race");
});
afterAll(async () => {
  await f.cleanup();
  await prisma.$disconnect();
});

async function race(staffId: string | undefined, startsAt: Date) {
  const results = await Promise.allSettled(
    Array.from({ length: N }, () =>
      reserveSlot({
        businessId: f.businessId,
        serviceId: f.service.id,
        customerId: f.customer.id,
        staffId,
        startsAt,
        now: NOW,
      }),
    ),
  );
  const won = results.filter((r) => r.status === "fulfilled").map((r) => r.value);
  const lost = results.filter((r) => r.status === "rejected").map((r) => r.reason);
  return { won, lost };
}

describe(`${N} parallel reservations`, () => {
  it("for one staff member: exactly one wins", async () => {
    const { won, lost } = await race(f.staff[0].id, at(10));
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(N - 1);
    expect(lost.every((e) => e instanceof SlotUnavailableError && e.reason === "STAFF_BUSY")).toBe(
      true,
    );
    expect(lost.some((e) => e instanceof SlotTakenError)).toBe(false);

    const rows = await prisma.booking.count({
      where: { businessId: f.businessId, startsAt: at(10), status: "CONFIRMED" },
    });
    expect(rows).toBe(1);
  });

  it("for 'any staff' with 3 staff and 2 chairs: exactly two win, on different staff and chairs", async () => {
    const { won, lost } = await race(undefined, at(11));
    expect(won).toHaveLength(2);
    expect(new Set(won.map((b) => b.staffId)).size).toBe(2);
    expect(new Set(won.map((b) => b.resources[0].resourceId)).size).toBe(2);
    expect(lost).toHaveLength(N - 2);
    expect(lost.every((e) => e instanceof SlotUnavailableError && e.reason === "NO_RESOURCE")).toBe(
      true,
    );
  });
});
