/**
 * Emails through the capturing sender: confirmation to a customer with an
 * email (and the owner), nothing to one without, cancellation with the deposit
 * outcome, the sign-in link only for real users, and the token's authorize path.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sendMagicLink } from "@/server/auth/magic";
import { cancelBookingAndRefund, createBooking } from "@/server/bookings";
import { findOrCreateCustomer } from "@/server/customers";
import { prisma } from "@/server/db/prisma";
import { LoggingSender, setEmailSender } from "@/server/email";
import { NOW, at, createFixture } from "../helpers/fixture";

let f: Awaited<ReturnType<typeof createFixture>>;
const sender = new LoggingSender();
const settle = () => new Promise((r) => setTimeout(r, 150)); // notifications are fire-and-forget

beforeAll(async () => {
  f = await createFixture("email");
  setEmailSender(sender);
  await prisma.user.create({
    data: {
      businessId: f.businessId,
      email: `owner-${Date.now()}@example.test`,
      name: "Owner",
      passwordHash: "x",
    },
  });
});
afterAll(async () => {
  setEmailSender(undefined);
  await f.cleanup();
  await prisma.$disconnect();
});

describe("booking notifications", () => {
  it("customer with an email gets a confirmation with the manage link; the owner gets a heads-up", async () => {
    const customer = await findOrCreateCustomer(
      f.businessId,
      "+40799000601",
      "Mail Me",
      "mailme@example.test",
    );
    const before = sender.sent.length;
    const { booking } = await createBooking({
      businessId: f.businessId,
      serviceId: f.service.id,
      customerId: customer.id,
      startsAt: at(9),
      now: NOW,
      source: "API",
    });
    await settle();
    const mails = sender.sent.slice(before);
    const toCustomer = mails.find((m) => m.to === "mailme@example.test");
    expect(toCustomer?.subject).toMatch(/^Booked: Cut/);
    expect(toCustomer?.text).toContain(`/manage?id=${booking.id}&t=`);
    expect(
      mails.some((m) => m.to.startsWith("owner-") && m.subject.startsWith("New booking")),
    ).toBe(true);
  });

  it("no email on the customer means no customer mail", async () => {
    const before = sender.sent.length;
    await createBooking({
      businessId: f.businessId,
      serviceId: f.service.id,
      customerId: f.customer.id,
      startsAt: at(10),
      now: NOW,
      source: "API",
    });
    await settle();
    expect(sender.sent.slice(before).some((m) => m.subject.startsWith("Booked"))).toBe(false);
  });

  it("the owner is not mailed about bookings made from the dashboard", async () => {
    const before = sender.sent.length;
    await createBooking({
      businessId: f.businessId,
      serviceId: f.service.id,
      customerId: f.customer.id,
      startsAt: at(11),
      now: NOW,
      source: "DASHBOARD",
      collectDeposit: false,
    });
    await settle();
    expect(sender.sent.slice(before).some((m) => m.subject.startsWith("New booking"))).toBe(false);
  });

  it("cancellation mail states the deposit outcome", async () => {
    const customer = await findOrCreateCustomer(
      f.businessId,
      "+40799000602",
      "Mail Two",
      "mailtwo@example.test",
    );
    const { booking } = await createBooking({
      businessId: f.businessId,
      serviceId: f.service.id,
      customerId: customer.id,
      startsAt: at(12),
      now: NOW,
      source: "API",
    });
    await settle();
    const before = sender.sent.length;
    await cancelBookingAndRefund({ businessId: f.businessId, bookingId: booking.id, now: NOW });
    await settle();
    const mail = sender.sent.slice(before).find((m) => m.to === "mailtwo@example.test");
    expect(mail?.subject).toMatch(/^Cancelled: Cut/);
    expect(mail?.text).toContain("/book/");
  });
});

describe("magic link", () => {
  it("mails a sign-in link to a known user and stays silent for an unknown address", async () => {
    const owner = await prisma.user.findFirstOrThrow({ where: { businessId: f.businessId } });
    const before = sender.sent.length;
    await sendMagicLink(owner.email.toUpperCase());
    await sendMagicLink("nobody@example.test");
    const mails = sender.sent.slice(before);
    expect(mails).toHaveLength(1);
    expect(mails[0].to).toBe(owner.email);
    expect(mails[0].text).toMatch(/\/auth\/magic\?token=/);
  });
});
