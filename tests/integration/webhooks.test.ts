/**
 * The inbound webhook layer on real Postgres: persist-then-ack, signature,
 * dedupe, retry with backoff, dead letters and replay, atomic claims, and
 * out-of-order reconciliation through the simulator provider.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { env } from "@/env";
import { prisma } from "@/server/db/prisma";
import { addDays, localMinutesToUtc, localWeekday, toLocalDate } from "@/server/scheduling/time";
import {
  type HandlerOutcome,
  MAX_ATTEMPTS,
  hmacSha256Hex,
  ingest,
  listEvents,
  processDue,
  processEvent,
  registerProvider,
  replayEvent,
} from "@/server/webhooks";
import { TZ, createFixture } from "../helpers/fixture";

// --- a scripted provider so tests control what the handler does ------------

const script = new Map<string, () => Promise<HandlerOutcome>>();
const calls = new Map<string, number>();

registerProvider(
  {
    name: "test",
    verify: (_raw, headers) => headers.get("x-test-sig") === "ok",
    parse: (raw) =>
      (JSON.parse(raw) as { id: string; type?: string; key?: string }[]).map((e) => ({
        providerEventId: e.id,
        eventType: e.type ?? "thing",
        correlationKey: e.key,
        payload: e,
      })),
  },
  async (event) => {
    calls.set(event.providerEventId, (calls.get(event.providerEventId) ?? 0) + 1);
    const fn = script.get(event.providerEventId);
    return fn ? fn() : { kind: "processed", result: { echo: event.providerEventId } };
  },
);

const uid = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const sent = (events: object[]) =>
  ingest("test", JSON.stringify(events), new Headers({ "x-test-sig": "ok" }));
const row = (providerEventId: string) =>
  prisma.inboundEvent.findUniqueOrThrow({
    where: { provider_providerEventId: { provider: "test", providerEventId } },
  });

afterAll(async () => {
  await prisma.webhookDelivery.deleteMany({ where: { provider: { in: ["test", "simulator"] } } });
  await prisma.$disconnect();
});

describe("ingest", () => {
  it("stores the raw delivery and one row per event, answers 200", async () => {
    const a = uid();
    const b = uid();
    const r = await sent([{ id: a }, { id: b }]);
    expect(r.status).toBe(200);
    if (r.status !== 200) return;
    expect(r.newEventIds).toHaveLength(2);
    expect(r.duplicateCount).toBe(0);
    const delivery = await prisma.webhookDelivery.findUniqueOrThrow({
      where: { id: r.deliveryId },
      include: { events: true },
    });
    expect(delivery.signatureValid).toBe(true);
    expect(delivery.rawBody).toContain(a);
    expect(delivery.events.map((e) => e.status)).toEqual(["RECEIVED", "RECEIVED"]);
  });

  it("keeps a delivery with a bad signature but creates no events, answers 401", async () => {
    const r = await ingest("test", JSON.stringify([{ id: uid() }]), new Headers());
    expect(r.status).toBe(401);
    if (r.status !== 401) return;
    const delivery = await prisma.webhookDelivery.findUniqueOrThrow({
      where: { id: r.deliveryId },
      include: { events: true },
    });
    expect(delivery.signatureValid).toBe(false);
    expect(delivery.events).toHaveLength(0);
  });

  it("answers 400 for a malformed body, 404 for an unknown provider", async () => {
    expect((await ingest("test", "not json", new Headers({ "x-test-sig": "ok" }))).status).toBe(
      400,
    );
    expect((await ingest("nope", "{}", new Headers())).status).toBe(404);
  });

  it("dedupes on provider event id: redelivery creates nothing and runs nothing twice", async () => {
    const id = uid();
    const first = await sent([{ id }]);
    expect(first.status === 200 && first.newEventIds.length).toBe(1);
    await processEvent((first as { newEventIds: string[] }).newEventIds[0]);

    const again = await sent([{ id }]);
    expect(again.status).toBe(200);
    if (again.status !== 200) return;
    expect(again.newEventIds).toHaveLength(0);
    expect(again.duplicateCount).toBe(1);
    // The sweeper finds nothing new either.
    await processDue();
    expect(calls.get(id)).toBe(1);
    expect((await row(id)).status).toBe("PROCESSED");
  });
});

describe("processEvent", () => {
  const now = new Date("2030-01-01T00:00:00Z");
  const noJitter = () => 0;

  it("records processed outcomes with their result", async () => {
    const id = uid();
    const r = (await sent([{ id }])) as { newEventIds: string[] };
    expect(await processEvent(r.newEventIds[0], { now })).toEqual({
      kind: "processed",
      result: { echo: id },
    });
    const e = await row(id);
    expect(e.status).toBe("PROCESSED");
    expect(e.attempts).toBe(1);
    expect(e.result).toEqual({ echo: id });
    expect(e.processedAt?.toISOString()).toBe(now.toISOString());
  });

  it("retries a transient failure with exponential backoff, then succeeds via the sweeper", async () => {
    const id = uid();
    let left = 2;
    script.set(id, async () => {
      if (left-- > 0) throw new Error("upstream 503");
      return { kind: "processed" };
    });
    const r = (await sent([{ id }])) as { newEventIds: string[] };
    const eventId = r.newEventIds[0];

    await processEvent(eventId, { now, random: noJitter });
    let e = await row(id);
    expect(e.status).toBe("FAILED");
    expect(e.attempts).toBe(1);
    expect(e.lastError).toBe("upstream 503");
    expect(e.nextAttemptAt?.getTime()).toBe(now.getTime() + 60_000);

    // Not due yet: the sweeper leaves it alone.
    await processDue({ now: new Date(now.getTime() + 30_000), random: noJitter });
    expect((await row(id)).attempts).toBe(1);

    // Due: second attempt fails, backoff doubles.
    const t2 = new Date(now.getTime() + 60_000);
    await processDue({ now: t2, random: noJitter });
    e = await row(id);
    expect(e.attempts).toBe(2);
    expect(e.nextAttemptAt?.getTime()).toBe(t2.getTime() + 120_000);

    // Third attempt succeeds.
    await processDue({ now: new Date(t2.getTime() + 120_000), random: noJitter });
    e = await row(id);
    expect(e.status).toBe("PROCESSED");
    expect(e.attempts).toBe(3);
    expect(e.lastError).toBeNull();
    expect(calls.get(id)).toBe(3);
  });

  it("dead-letters after MAX_ATTEMPTS and can be replayed", async () => {
    const id = uid();
    let broken = true;
    script.set(id, async () => {
      if (broken) throw new Error("always");
      return { kind: "processed", result: "fixed" };
    });
    const r = (await sent([{ id }])) as { newEventIds: string[] };
    const eventId = r.newEventIds[0];

    let t = now;
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await processDue({ now: t, random: noJitter });
      t = new Date(t.getTime() + 2 * 60 * 60_000);
    }
    let e = await row(id);
    expect(e.status).toBe("DEAD");
    expect(e.attempts).toBe(MAX_ATTEMPTS);
    expect(e.nextAttemptAt).toBeNull();

    // Dead means the sweeper ignores it.
    await processDue({ now: t });
    expect((await row(id)).attempts).toBe(MAX_ATTEMPTS);
    expect(
      (await listEvents({ status: "DEAD", provider: "test" })).some((x) => x.id === eventId),
    ).toBe(true);

    broken = false;
    expect(await replayEvent(eventId, { now: t })).toEqual({ kind: "processed", result: "fixed" });
    e = await row(id);
    expect(e.status).toBe("PROCESSED");
    expect(e.attempts).toBe(1);
  });

  it("reject dead-letters immediately, skipped is terminal without error", async () => {
    const bad = uid();
    const meh = uid();
    script.set(bad, async () => ({ kind: "reject", reason: "poison" }));
    script.set(meh, async () => ({ kind: "skipped", reason: "nothing to do" }));
    const r = (await sent([{ id: bad }, { id: meh }])) as { newEventIds: string[] };
    for (const id of r.newEventIds) await processEvent(id, { now });
    expect((await row(bad)).status).toBe("DEAD");
    expect((await row(bad)).lastError).toBe("poison");
    expect((await row(meh)).status).toBe("SKIPPED");
    await processDue({ now: new Date("2031-01-01T00:00:00Z") });
    expect(calls.get(bad)).toBe(1);
    expect(calls.get(meh)).toBe(1);
  });

  it("claims atomically: concurrent workers run the handler once", async () => {
    const id = uid();
    script.set(id, async () => {
      await new Promise((r) => setTimeout(r, 50));
      return { kind: "processed" };
    });
    const r = (await sent([{ id }])) as { newEventIds: string[] };
    const results = await Promise.all(
      Array.from({ length: 10 }, () => processEvent(r.newEventIds[0], { now })),
    );
    expect(results.filter((x) => x !== null)).toHaveLength(1);
    expect(calls.get(id)).toBe(1);
  });

  it("returns null for an unknown or already-processed event", async () => {
    expect(await processEvent("00000000-0000-0000-0000-000000000000")).toBeNull();
  });
});

describe("out-of-order delivery through the simulator provider", () => {
  let f: Awaited<ReturnType<typeof createFixture>>;
  let slug: string;
  let startsAt: Date;

  beforeAll(async () => {
    f = await createFixture("webhook");
    slug = (await prisma.business.findUniqueOrThrow({ where: { id: f.businessId } })).slug;
    // A weekday 3-9 days out at 10:00 local: inside lead time and the horizon.
    let date = addDays(toLocalDate(new Date(), TZ), 3);
    while (localWeekday(date, TZ) === 0) date = addDays(date, 1);
    startsAt = localMinutesToUtc(date, 10 * 60, TZ);
  });
  afterAll(async () => {
    await f.cleanup();
  });

  const simulate = (events: { id: string; type: string; data: object }[]) => {
    const raw = JSON.stringify({ events });
    return ingest(
      "simulator",
      raw,
      new Headers({ "x-signature": `sha256=${hmacSha256Hex(env.WEBHOOK_SIMULATOR_SECRET, raw)}` }),
    );
  };

  it("a cancel that arrives before its create waits, then runs when the create lands", async () => {
    const clientRef = `ref-${uid()}`;
    const now = new Date();

    // 1. Cancel first. Nothing to cancel yet: deferred, not failed, not dead.
    const c = (await simulate([
      { id: `c-${clientRef}`, type: "booking.cancelled", data: { clientRef } },
    ])) as { newEventIds: string[] };
    expect(await processEvent(c.newEventIds[0], { now })).toMatchObject({ kind: "defer" });
    const cancelRow = await prisma.inboundEvent.findUniqueOrThrow({
      where: { id: c.newEventIds[0] },
    });
    expect(cancelRow.status).toBe("DEFERRED");
    expect(cancelRow.nextAttemptAt).not.toBeNull();

    // 2. The create arrives. It books, then re-runs the deferred sibling at once.
    const r = (await simulate([
      {
        id: `r-${clientRef}`,
        type: "booking.requested",
        data: {
          clientRef,
          business: slug,
          service: f.service.id,
          startsAt: startsAt.toISOString(),
          customer: { phone: "+40700000077", name: "Ooo" },
        },
      },
    ])) as { newEventIds: string[] };
    expect(await processEvent(r.newEventIds[0], { now })).toMatchObject({ kind: "processed" });

    const createRow = await prisma.inboundEvent.findUniqueOrThrow({
      where: { id: r.newEventIds[0] },
    });
    const bookingId = (createRow.result as { bookingId: string }).bookingId;
    const after = await prisma.inboundEvent.findUniqueOrThrow({ where: { id: c.newEventIds[0] } });
    expect(after.status).toBe("PROCESSED");
    expect(after.result).toEqual({ bookingId, status: "CANCELLED" });

    const booking = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
    expect(booking.status).toBe("CANCELLED");
    expect(booking.source).toBe("SIMULATOR");
  });

  it("a request the engine refuses is SKIPPED, not retried", async () => {
    const clientRef = `ref-${uid()}`;
    const r = (await simulate([
      {
        id: `r-${clientRef}`,
        type: "booking.requested",
        data: {
          clientRef,
          business: slug,
          service: f.service.id,
          startsAt: new Date(startsAt.getTime() + 5 * 60_000).toISOString(), // off grid
          customer: { phone: "+40700000078" },
        },
      },
    ])) as { newEventIds: string[] };
    expect(await processEvent(r.newEventIds[0])).toMatchObject({ kind: "skipped" });
    const e = await prisma.inboundEvent.findUniqueOrThrow({ where: { id: r.newEventIds[0] } });
    expect(e.lastError).toContain("NOT_ON_GRID");
  });

  it("a malformed payload is rejected straight to the dead letter", async () => {
    const r = (await simulate([
      { id: `bad-${uid()}`, type: "booking.requested", data: { nope: true } },
    ])) as { newEventIds: string[] };
    expect(await processEvent(r.newEventIds[0])).toMatchObject({ kind: "reject" });
    const e = await prisma.inboundEvent.findUniqueOrThrow({ where: { id: r.newEventIds[0] } });
    expect(e.status).toBe("DEAD");
  });
});
