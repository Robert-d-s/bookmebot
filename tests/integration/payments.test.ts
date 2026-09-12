/**
 * Deposits end to end with the fake gateway on real Postgres: a deposit
 * service books as a PENDING hold with a checkout link, the Stripe webhook
 * confirms it, cancelling refunds it, an expired checkout releases the hold,
 * and the sweeper reconciles holds the engine released. Also the chat path:
 * confirm_booking hands the customer the payment link.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { env } from "@/env";
import { cancelBookingAndRefund, createBooking } from "@/server/bookings";
import { handleInboundMessage } from "@/server/channels/inbound";
import { prisma } from "@/server/db/prisma";
import { FakeGateway, setGateway, sweepPayments } from "@/server/payments";
import { releaseExpiredHolds } from "@/server/scheduling";
import { ingest, processEvent } from "@/server/webhooks";
import { signStripe } from "@/server/webhooks/signature";
import { addDays, localWeekday, toLocalDate } from "@/server/scheduling/time";
import { NOW, TZ, at, createFixture } from "../helpers/fixture";

let f: Awaited<ReturnType<typeof createFixture>>;
let depositService: { id: string };
const gateway = new FakeGateway();
const secret = env.STRIPE_WEBHOOK_SECRET!;

beforeAll(async () => {
  f = await createFixture("payments");
  setGateway(gateway);
  depositService = await prisma.service.create({
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
});
afterAll(async () => {
  setGateway(undefined);
  await prisma.webhookDelivery.deleteMany({ where: { provider: "stripe" } });
  await f.cleanup();
  await prisma.$disconnect();
});

const base = (startsAt: Date) => ({
  businessId: f.businessId,
  serviceId: depositService.id,
  customerId: f.customer.id,
  startsAt,
  now: NOW,
  source: "API" as const,
});

async function stripeEvent(type: string, object: Record<string, unknown>, now = new Date()) {
  const raw = JSON.stringify({
    id: `evt_${type}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    type,
    data: { object },
  });
  const r = await ingest(
    "stripe",
    raw,
    new Headers({ "stripe-signature": signStripe(secret, raw, now) }),
  );
  if (r.status !== 200) throw new Error(`ingest ${r.status}`);
  const outcomes = [];
  for (const id of r.newEventIds) outcomes.push(await processEvent(id, { now }));
  return outcomes[0];
}

describe("deposit on booking", () => {
  it("a service without a deposit confirms directly", async () => {
    const { booking, payment } = await createBooking({ ...base(at(9)), serviceId: f.service.id });
    expect(booking.status).toBe("CONFIRMED");
    expect(payment).toBeUndefined();
  });

  it("a deposit service is held PENDING with a checkout link, then confirmed by the webhook", async () => {
    const { booking, payment } = await createBooking(base(at(10)));
    expect(booking.status).toBe("PENDING");
    expect(booking.holdExpiresAt?.getTime()).toBe(NOW.getTime() + 30 * 60_000);
    expect(payment?.amountCents).toBe(5000);
    expect(payment?.url).toMatch(/\/pay\/cs_fake_/);
    const row = await prisma.payment.findUniqueOrThrow({ where: { bookingId: booking.id } });
    expect(row.status).toBe("REQUIRES_PAYMENT");

    const outcome = await stripeEvent("checkout.session.completed", {
      id: row.checkoutSessionId,
      object: "checkout.session",
      payment_status: "paid",
      payment_intent: "pi_1",
      metadata: { bookingId: booking.id },
    });
    expect(outcome).toMatchObject({
      kind: "processed",
      result: { bookingStatus: "CONFIRMED", already: false },
    });
    const after = await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } });
    expect(after.status).toBe("CONFIRMED");
    expect(after.holdExpiresAt).toBeNull();
    expect(
      (await prisma.payment.findUniqueOrThrow({ where: { bookingId: booking.id } })).status,
    ).toBe("PAID");

    // Redelivery is a no-op at the payment level too (new event id, same session).
    const again = await stripeEvent("checkout.session.completed", {
      id: row.checkoutSessionId,
      object: "checkout.session",
      payment_status: "paid",
      payment_intent: "pi_1",
    });
    expect(again).toMatchObject({ kind: "processed", result: { already: true } });
  });

  it("the owner booking in person collects no deposit", async () => {
    const { booking, payment } = await createBooking({
      ...base(at(11)),
      collectDeposit: false,
      source: "DASHBOARD",
    });
    expect(booking.status).toBe("CONFIRMED");
    expect(payment).toBeUndefined();
  });
});

describe("refund on cancel", () => {
  it("cancelling a paid booking refunds the deposit (fake gateway succeeds synchronously)", async () => {
    const { booking } = await createBooking(base(at(12)));
    const row = await prisma.payment.findUniqueOrThrow({ where: { bookingId: booking.id } });
    await stripeEvent("checkout.session.completed", {
      id: row.checkoutSessionId,
      object: "checkout.session",
      payment_status: "paid",
      payment_intent: "pi_refund_me",
    });

    const before = gateway.refunds.length;
    const cancelled = await cancelBookingAndRefund({
      businessId: f.businessId,
      bookingId: booking.id,
      now: NOW,
    });
    expect(cancelled.status).toBe("CANCELLED");
    expect(gateway.refunds.slice(before)).toEqual(["pi_refund_me"]);
    const p = await prisma.payment.findUniqueOrThrow({ where: { bookingId: booking.id } });
    expect(p.status).toBe("REFUNDED");
    expect(p.refundId).toMatch(/^re_fake_/);

    // Stripe's own confirmation arrives later: idempotent.
    const r = await stripeEvent("charge.refunded", {
      id: "ch_1",
      object: "charge",
      payment_intent: "pi_refund_me",
      refunds: { data: [{ id: p.refundId }] },
    });
    expect(r).toMatchObject({ kind: "processed", result: { changed: false } });
  });

  it("cancelling an unpaid hold expires the checkout instead", async () => {
    const { booking } = await createBooking(base(at(13)));
    await cancelBookingAndRefund({ businessId: f.businessId, bookingId: booking.id, now: NOW });
    expect(
      (await prisma.payment.findUniqueOrThrow({ where: { bookingId: booking.id } })).status,
    ).toBe("EXPIRED");
  });

  it("a refund for a payment we have not seen yet is deferred, not lost", async () => {
    const r = await stripeEvent("charge.refunded", {
      id: "ch_x",
      object: "charge",
      payment_intent: "pi_unknown",
      refunds: { data: [] },
    });
    expect(r).toMatchObject({ kind: "defer" });
  });
});

describe("expiry", () => {
  it("checkout.session.expired cancels the held booking", async () => {
    const { booking } = await createBooking(base(at(14)));
    const row = await prisma.payment.findUniqueOrThrow({ where: { bookingId: booking.id } });
    await stripeEvent("checkout.session.expired", {
      id: row.checkoutSessionId,
      object: "checkout.session",
    });
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).status).toBe(
      "CANCELLED",
    );
    expect(
      (await prisma.payment.findUniqueOrThrow({ where: { bookingId: booking.id } })).status,
    ).toBe("EXPIRED");
  });

  it("when the engine releases an expired hold, the sweeper expires its payment", async () => {
    const { booking } = await createBooking(base(at(15)));
    expect(await releaseExpiredHolds(new Date(NOW.getTime() + 31 * 60_000))).toBeGreaterThanOrEqual(
      1,
    );
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).status).toBe(
      "CANCELLED",
    );
    const sweep = await sweepPayments();
    expect(sweep.expired).toBeGreaterThanOrEqual(1);
    expect(
      (await prisma.payment.findUniqueOrThrow({ where: { bookingId: booking.id } })).status,
    ).toBe("EXPIRED");
  });

  it("a payment that lands after the hold lapsed is refunded automatically", async () => {
    const { booking } = await createBooking(base(at(16)));
    const row = await prisma.payment.findUniqueOrThrow({ where: { bookingId: booking.id } });
    await releaseExpiredHolds(new Date(NOW.getTime() + 31 * 60_000));
    const before = gateway.refunds.length;
    await stripeEvent("checkout.session.completed", {
      id: row.checkoutSessionId,
      object: "checkout.session",
      payment_status: "paid",
      payment_intent: "pi_late",
    });
    expect(gateway.refunds.slice(before)).toEqual(["pi_late"]);
    expect(
      (await prisma.payment.findUniqueOrThrow({ where: { bookingId: booking.id } })).status,
    ).toBe("REFUNDED");
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).status).toBe(
      "CANCELLED",
    );
  });
});

describe("deposit through chat", () => {
  it("confirm_booking hands over the payment link and the booking stays PENDING", async () => {
    const phone = "+40799000950";
    const send = (m: {
      text?: string;
      replyId?: string;
      kind?: "text" | "list_reply" | "button_reply";
    }) =>
      handleInboundMessage({
        businessId: f.businessId,
        channel: "SIMULATOR",
        phone,
        message: {
          kind: m.kind ?? "text",
          text: m.text ?? "",
          replyId: m.replyId,
          providerMessageId: `pay-${Date.now()}-${Math.random()}`,
        },
      });
    const lastOut = () =>
      prisma.message.findFirstOrThrow({
        where: { businessId: f.businessId, customer: { phone }, direction: "OUT" },
        orderBy: { createdAt: "desc" },
      });

    // The chat path runs on the real clock: pick a weekday inside the horizon.
    let day = addDays(toLocalDate(new Date(), TZ), 3);
    while (localWeekday(day, TZ) === 0) day = addDays(day, 1);
    await send({ text: `book a Colour on ${day}` });
    const list = await lastOut();
    const slot = (list.payload as { rows: { id: string }[] }).rows.at(-1)!.id;
    await send({ kind: "list_reply", replyId: slot, text: "last" });
    const confirm = (await lastOut()).payload as { buttons: { id: string }[] };
    await send({ kind: "button_reply", replyId: confirm.buttons[0].id, text: "Yes" });
    const reply = await lastOut();
    expect(reply.text).toMatch(/pay the 50 RON deposit/);
    expect(reply.text).toMatch(/\/pay\/cs_fake_/);
    expect(reply.text).toMatch(/held for 30 minutes/);
    const booking = await prisma.booking.findFirstOrThrow({
      where: { businessId: f.businessId, customer: { phone } },
    });
    expect(booking.status).toBe("PENDING");
  });
});

describe("refund cutoff", () => {
  const cutoffBusiness = () =>
    prisma.business.update({ where: { id: f.businessId }, data: { refundCutoffHours: 24 } });

  async function paidBooking(startsAt: Date) {
    const { booking } = await createBooking(base(startsAt));
    const row = await prisma.payment.findUniqueOrThrow({ where: { bookingId: booking.id } });
    await stripeEvent("checkout.session.completed", {
      id: row.checkoutSessionId,
      object: "checkout.session",
      payment_status: "paid",
      payment_intent: `pi_cut_${booking.id.slice(0, 8)}`,
    });
    return booking;
  }

  it("a customer cancelling inside the cutoff forfeits the deposit; outside it is refunded", async () => {
    await cutoffBusiness();
    // Fixture Monday is 2030-01-07; NOW is the day before at 12:00Z, so 09:00 local is ~19h away.
    const late = await paidBooking(at(9, 30));
    const r1 = await cancelBookingAndRefund({
      businessId: f.businessId,
      bookingId: late.id,
      now: NOW,
      refundPolicy: "apply",
    });
    expect(r1.deposit).toBe("FORFEITED");
    expect((await prisma.payment.findUniqueOrThrow({ where: { bookingId: late.id } })).status).toBe(
      "FORFEITED",
    );

    const early = await paidBooking(at(17));
    const r2 = await cancelBookingAndRefund({
      businessId: f.businessId,
      bookingId: early.id,
      now: new Date(NOW.getTime() - 24 * 3_600_000),
      refundPolicy: "apply",
    });
    expect(r2.deposit).toBe("REFUNDED");
  });

  it("the owner cancelling always refunds", async () => {
    await cutoffBusiness();
    const b = await paidBooking(at(9, 45));
    const r = await cancelBookingAndRefund({ businessId: f.businessId, bookingId: b.id, now: NOW });
    expect(r.deposit).toBe("REFUNDED");
  });

  it("a cutoff of 0 always refunds", async () => {
    await prisma.business.update({ where: { id: f.businessId }, data: { refundCutoffHours: 0 } });
    const b = await paidBooking(at(17, 15));
    const r = await cancelBookingAndRefund({
      businessId: f.businessId,
      bookingId: b.id,
      now: new Date(b.startsAt.getTime() - 5 * 60_000),
      refundPolicy: "apply",
    });
    expect(r.deposit).toBe("REFUNDED");
  });
});
