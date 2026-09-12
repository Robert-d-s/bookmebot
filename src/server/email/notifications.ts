import { manageUrl } from "@/server/bookings/token";
import { prisma } from "@/server/db/prisma";
import { reportError } from "@/server/observability";
import { getEmailSender } from "./index";

/**
 * Transactional emails. Every function is best-effort: a mail failure is
 * reported, never thrown into the booking path that triggered it.
 */
const fmt = (d: Date, tz: string) =>
  new Intl.DateTimeFormat("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: tz,
  }).format(d);

async function load(bookingId: string) {
  return prisma.booking.findUnique({
    where: { id: bookingId },
    include: {
      customer: true,
      service: true,
      staff: true,
      business: { include: { users: { select: { email: true } } } },
    },
  });
}

async function trySend(
  to: string | null | undefined,
  subject: string,
  text: string,
  context: Record<string, unknown>,
) {
  if (!to) return false;
  try {
    await getEmailSender().send({ to, subject, text });
    return true;
  } catch (err) {
    reportError(err, { ...context, subject });
    return false;
  }
}

/** Customer: "you're booked" with the manage link. Owner: heads-up for non-dashboard bookings. */
export async function notifyBookingConfirmed(bookingId: string) {
  const b = await load(bookingId);
  if (!b || b.status !== "CONFIRMED") return;
  const when = fmt(b.startsAt, b.business.timezone);
  await trySend(
    b.customer.email,
    `Booked: ${b.service.name} on ${when}`,
    [
      `Hi ${b.customer.name ?? ""}`.trim() + ",",
      "",
      `You're booked at ${b.business.name}:`,
      `${b.service.name} with ${b.staff.name}`,
      when,
      "",
      `Need to cancel? ${manageUrl(b.business.slug, b.id)}`,
    ].join("\n"),
    { bookingId, kind: "customer_confirmed" },
  );
  if (b.source !== "DASHBOARD") {
    for (const u of b.business.users) {
      await trySend(
        u.email,
        `New booking: ${b.service.name}, ${when}`,
        `${b.customer.name ?? b.customer.phone} booked ${b.service.name} with ${b.staff.name} on ${when} (via ${b.source.toLowerCase()}).`,
        { bookingId, kind: "owner_new_booking" },
      );
    }
  }
}

export async function notifyBookingCancelled(bookingId: string, deposit?: string) {
  const b = await load(bookingId);
  if (!b) return;
  const when = fmt(b.startsAt, b.business.timezone);
  const depositLine =
    deposit === "REFUNDED" || deposit === "REFUND_PENDING"
      ? "Your deposit will be refunded."
      : deposit === "FORFEITED"
        ? "As the cancellation was inside the cutoff, the deposit is not refunded."
        : "";
  await trySend(
    b.customer.email,
    `Cancelled: ${b.service.name} on ${when}`,
    [
      `Your ${b.service.name} at ${b.business.name} on ${when} is cancelled.`,
      depositLine,
      "",
      `Book again: ${process.env.APP_URL ?? ""}/book/${b.business.slug}`,
    ]
      .filter(Boolean)
      .join("\n"),
    { bookingId, kind: "customer_cancelled" },
  );
}
