import { env } from "@/env";
import { track } from "@/server/analytics";
import { pushSoon } from "@/server/calendar/sync";
import { notifyBookingConfirmed } from "@/server/email/notifications";
import { prisma } from "@/server/db/prisma";
import { getGateway } from "./gateway";

/**
 * Deposit lifecycle. Every state change is idempotent because Stripe
 * redelivers and the sweeper re-runs:
 *
 *   createDepositCheckout   booking PENDING  -> payment REQUIRES_PAYMENT + checkout link
 *   markPaid (webhook)      payment PAID, booking PENDING -> CONFIRMED
 *                           (booking already CANCELLED? refund straight away)
 *   markCheckoutExpired     payment EXPIRED, booking PENDING -> CANCELLED
 *   refundDeposit (cancel)  payment PAID -> REFUNDED | REFUND_PENDING
 *   markRefunded (webhook)  payment -> REFUNDED
 *   sweep                   holds released by the engine -> payments EXPIRED;
 *                           REFUND_PENDING without a refund id -> retried
 */

export const HOLD_MINUTES = 30;

export { FakeGateway, getGateway, paymentsEnabled, setGateway } from "./gateway";

export async function createDepositCheckout(bookingId: string, now: Date = new Date()) {
  const gateway = getGateway();
  if (!gateway) throw new Error("payments are not configured");
  const booking = await prisma.booking.findUniqueOrThrow({
    where: { id: bookingId },
    include: { service: true, business: { select: { id: true, name: true } } },
  });
  if (booking.service.depositCents <= 0) throw new Error("service has no deposit");
  const expiresAt = booking.holdExpiresAt ?? new Date(now.getTime() + HOLD_MINUTES * 60_000);

  const checkout = await gateway.createCheckout({
    amountCents: booking.service.depositCents,
    currency: booking.service.currency,
    description: `Deposit: ${booking.service.name} at ${booking.business.name}`,
    bookingId: booking.id,
    businessId: booking.business.id,
    expiresAt,
    successUrl: `${env.APP_URL}/pay/${"{CHECKOUT_SESSION_ID}"}?paid=1`,
    cancelUrl: `${env.APP_URL}/pay/${"{CHECKOUT_SESSION_ID}"}?cancelled=1`,
  });

  return prisma.payment.upsert({
    where: { bookingId: booking.id },
    create: {
      businessId: booking.business.id,
      bookingId: booking.id,
      amountCents: booking.service.depositCents,
      currency: booking.service.currency,
      checkoutSessionId: checkout.id,
      checkoutUrl: checkout.url,
    },
    update: {
      checkoutSessionId: checkout.id,
      checkoutUrl: checkout.url,
      status: "REQUIRES_PAYMENT",
    },
  });
}

export async function markPaid(args: {
  checkoutSessionId: string;
  paymentIntentId: string | null;
  chargeId?: string | null;
  now?: Date;
}) {
  const now = args.now ?? new Date();
  const payment = await prisma.payment.findUnique({
    where: { checkoutSessionId: args.checkoutSessionId },
    include: { booking: true },
  });
  if (!payment) return null;
  if (
    payment.status === "PAID" ||
    payment.status === "REFUNDED" ||
    payment.status === "REFUND_PENDING"
  ) {
    return { payment, booking: payment.booking, already: true };
  }

  const [updatedPayment, booking] = await prisma.$transaction([
    prisma.payment.update({
      where: { id: payment.id },
      data: {
        status: "PAID",
        paidAt: now,
        paymentIntentId: args.paymentIntentId,
        chargeId: args.chargeId ?? undefined,
        lastError: null,
      },
    }),
    prisma.booking.updateMany({
      where: { id: payment.bookingId, status: "PENDING" },
      data: { status: "CONFIRMED", holdExpiresAt: null, version: { increment: 1 } },
    }),
  ]);
  const fresh = await prisma.booking.findUniqueOrThrow({ where: { id: payment.bookingId } });
  // Paid after the hold lapsed and the sweeper cancelled the booking: give it back.
  if (booking.count === 0 && fresh.status === "CANCELLED") {
    await refundDeposit(payment.bookingId, now);
  }
  if (booking.count > 0) {
    pushSoon(payment.bookingId);
    void notifyBookingConfirmed(payment.bookingId);
  }
  track(payment.businessId, "payment_paid", {
    amountCents: payment.amountCents,
    currency: payment.currency,
  });
  return { payment: updatedPayment, booking: fresh, already: false };
}

export async function markCheckoutExpired(checkoutSessionId: string, now: Date = new Date()) {
  const payment = await prisma.payment.findUnique({ where: { checkoutSessionId } });
  if (!payment) return null;
  if (payment.status !== "REQUIRES_PAYMENT") return { payment, changed: false };
  await prisma.$transaction([
    prisma.payment.update({ where: { id: payment.id }, data: { status: "EXPIRED" } }),
    prisma.booking.updateMany({
      where: { id: payment.bookingId, status: "PENDING" },
      data: { status: "CANCELLED", cancelledAt: now, version: { increment: 1 } },
    }),
  ]);
  return { payment, changed: true };
}

export type RefundPolicy = "apply" | "always";

/**
 * Called after a booking is cancelled. Safe to call when there is nothing to
 * refund. With policy "apply", a paid deposit is kept (FORFEITED) when the
 * cancellation is inside the business's refund cutoff; "always" is what the
 * owner gets from the dashboard.
 */
export async function refundDeposit(
  bookingId: string,
  now: Date = new Date(),
  policy: RefundPolicy = "always",
) {
  const payment = await prisma.payment.findUnique({
    where: { bookingId },
    include: { booking: { include: { business: { select: { refundCutoffHours: true } } } } },
  });
  if (!payment) return null;
  if (policy === "apply" && payment.status === "PAID") {
    const hoursBefore = (payment.booking.startsAt.getTime() - now.getTime()) / 3_600_000;
    if (hoursBefore < payment.booking.business.refundCutoffHours) {
      return prisma.payment.update({
        where: { id: payment.id },
        data: { status: "FORFEITED", lastError: null },
      });
    }
  }
  if (payment.status === "REQUIRES_PAYMENT") {
    await prisma.payment.update({ where: { id: payment.id }, data: { status: "EXPIRED" } });
    await getGateway()
      ?.expireCheckout(payment.checkoutSessionId ?? "")
      .catch(() => {});
    return prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
  }
  if (payment.status !== "PAID" && !(payment.status === "REFUND_PENDING" && !payment.refundId))
    return payment;
  if (!payment.paymentIntentId) {
    return prisma.payment.update({
      where: { id: payment.id },
      data: { status: "REFUND_PENDING", lastError: "no payment intent recorded" },
    });
  }
  const gateway = getGateway();
  if (!gateway) {
    return prisma.payment.update({
      where: { id: payment.id },
      data: { status: "REFUND_PENDING", lastError: "payments not configured" },
    });
  }
  try {
    const refund = await gateway.createRefund(payment.paymentIntentId);
    return await prisma.payment.update({
      where: { id: payment.id },
      data: {
        refundId: refund.id,
        status:
          refund.status === "succeeded"
            ? "REFUNDED"
            : refund.status === "failed"
              ? "FAILED"
              : "REFUND_PENDING",
        refundedAt: refund.status === "succeeded" ? now : null,
        lastError: null,
      },
    });
  } catch (err) {
    return prisma.payment.update({
      where: { id: payment.id },
      data: {
        status: "REFUND_PENDING",
        lastError: err instanceof Error ? err.message : String(err),
      },
    });
  }
}

export async function markRefunded(args: {
  paymentIntentId: string;
  refundId: string | null;
  now?: Date;
}) {
  const payment = await prisma.payment.findUnique({
    where: { paymentIntentId: args.paymentIntentId },
  });
  if (!payment) return null;
  if (payment.status === "REFUNDED") return { payment, changed: false };
  const updated = await prisma.payment.update({
    where: { id: payment.id },
    data: {
      status: "REFUNDED",
      refundId: args.refundId ?? payment.refundId,
      refundedAt: args.now ?? new Date(),
      lastError: null,
    },
  });
  return { payment: updated, changed: true };
}

/** For the cron tick: reconcile payments with holds the engine released, retry refunds. */
export async function sweepPayments(now: Date = new Date()) {
  const orphaned = await prisma.payment.findMany({
    where: { status: "REQUIRES_PAYMENT", booking: { status: "CANCELLED" } },
    select: { id: true, checkoutSessionId: true },
  });
  for (const p of orphaned) {
    await prisma.payment.update({ where: { id: p.id }, data: { status: "EXPIRED" } });
    await getGateway()
      ?.expireCheckout(p.checkoutSessionId ?? "")
      .catch(() => {});
  }
  const pending = await prisma.payment.findMany({
    where: { status: "REFUND_PENDING", refundId: null },
    select: { bookingId: true },
  });
  let refunded = 0;
  for (const p of pending) {
    const r = await refundDeposit(p.bookingId, now);
    if (r?.status === "REFUNDED") refunded += 1;
  }
  return { expired: orphaned.length, refundsRetried: pending.length, refunded };
}
