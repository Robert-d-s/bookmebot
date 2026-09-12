import { track } from "@/server/analytics";
import { pushSoon } from "@/server/calendar/sync";
import { prisma } from "@/server/db/prisma";
import {
  type BookingRecord,
  type CancelInput,
  type ReserveInput,
  cancelBooking,
  reserveSlot,
} from "@/server/scheduling";
import {
  HOLD_MINUTES,
  createDepositCheckout,
  paymentsEnabled,
  refundDeposit,
} from "@/server/payments";

/**
 * Booking orchestration above the engine: deposits on the way in, refunds on
 * the way out. Every caller that creates or cancels a booking on a customer's
 * behalf goes through here; the engine stays payment-agnostic.
 */
export interface CreateBookingResult {
  booking: BookingRecord;
  /** Present when a deposit is due: the booking is PENDING until paid. */
  payment?: { url: string; amountCents: number; currency: string; expiresAt: Date };
}

export async function createBooking(
  input: ReserveInput & { collectDeposit?: boolean },
): Promise<CreateBookingResult> {
  const service = await prisma.service.findFirst({
    where: { id: input.serviceId, businessId: input.businessId },
    select: { depositCents: true, currency: true },
  });
  const deposit =
    (service?.depositCents ?? 0) > 0 && input.collectDeposit !== false && paymentsEnabled();
  if (!deposit) {
    const booking = await reserveSlot({ ...input, status: "CONFIRMED" });
    pushSoon(booking.id);
    track(input.businessId, "booking_created", { source: booking.source, deposit: false });
    return { booking };
  }

  const booking = await reserveSlot({ ...input, status: "PENDING", holdMinutes: HOLD_MINUTES });
  try {
    const payment = await createDepositCheckout(booking.id, input.now);
    track(input.businessId, "booking_created", { source: booking.source, deposit: true });
    return {
      booking,
      payment: {
        url: payment.checkoutUrl ?? "",
        amountCents: payment.amountCents,
        currency: payment.currency,
        expiresAt: booking.holdExpiresAt ?? new Date(),
      },
    };
  } catch (err) {
    // No checkout, no hold: release the slot rather than block it for 30 minutes.
    await cancelBooking({ businessId: input.businessId, bookingId: booking.id, now: input.now });
    throw err;
  }
}

export async function cancelBookingAndRefund(input: CancelInput): Promise<BookingRecord> {
  const booking = await cancelBooking(input);
  await refundDeposit(booking.id, input.now);
  pushSoon(booking.id);
  track(input.businessId, "booking_cancelled", { source: booking.source });
  return booking;
}
