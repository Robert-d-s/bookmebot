import { notFound } from "next/navigation";
import { nowMs, verifyBookingToken } from "@/server/bookings/token";
import { prisma } from "@/server/db/prisma";
import { publicCancelAction } from "../actions";

const fmt = (d: Date, tz: string) =>
  new Intl.DateTimeFormat("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: tz,
  }).format(d);

const NOTE: Record<string, string> = {
  REFUNDED: "Cancelled. Your deposit has been refunded.",
  REFUND_PENDING: "Cancelled. Your deposit refund is on its way.",
  FORFEITED: "Cancelled. As this was inside the cancellation cutoff, the deposit is not refunded.",
  EXPIRED: "Cancelled.",
  NONE: "Cancelled.",
};

export default async function ManagePage(props: PageProps<"/book/[slug]/manage">) {
  const { slug } = await props.params;
  const sp = await props.searchParams;
  const id = typeof sp.id === "string" ? sp.id : "";
  const t = typeof sp.t === "string" ? sp.t : "";
  if (!verifyBookingToken(id, t)) notFound();
  const booking = await prisma.booking.findFirst({
    where: { id, business: { slug } },
    include: { service: true, staff: true, business: true, payment: true },
  });
  if (!booking) notFound();
  const tz = booking.business.timezone;
  const active = booking.status === "CONFIRMED" || booking.status === "PENDING";
  const hoursLeft = (booking.startsAt.getTime() - nowMs()) / 3_600_000;

  return (
    <main className="mx-auto w-full max-w-lg flex-1 space-y-4 p-6">
      <h1 className="text-2xl font-semibold">{booking.business.name}</h1>
      <p>
        <strong>{booking.service.name}</strong> with {booking.staff.name}
        <br />
        {fmt(booking.startsAt, tz)} · {booking.status}
      </p>
      {typeof sp.ok === "string" && (
        <p className="rounded bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">
          {NOTE[sp.ok] ?? "Done."}
        </p>
      )}
      {typeof sp.error === "string" && (
        <p className="rounded bg-red-50 px-3 py-2 text-sm text-red-800 dark:bg-red-950 dark:text-red-200">
          {sp.error}
        </p>
      )}
      {active && (
        <form action={publicCancelAction} className="space-y-2">
          <input type="hidden" name="slug" value={slug} />
          <input type="hidden" name="id" value={id} />
          <input type="hidden" name="t" value={t} />
          {booking.payment?.status === "PAID" && (
            <p className="text-sm text-zinc-500">
              {hoursLeft >= booking.business.refundCutoffHours
                ? "Cancelling now refunds your deposit."
                : `Cancelling less than ${booking.business.refundCutoffHours}h before the appointment forfeits the deposit.`}
            </p>
          )}
          <button className="rounded bg-red-700 px-4 py-2 text-sm text-white">
            Cancel booking
          </button>
        </form>
      )}
    </main>
  );
}
