import { notFound } from "next/navigation";
import { requireUser } from "@/server/auth/session";
import { getBooking, getBusiness, getCatalog } from "@/server/dashboard/queries";
import { prisma } from "@/server/db/prisma";
import { getAvailability } from "@/server/scheduling";
import { type LocalDate, toLocalDate } from "@/server/scheduling/time";
import { cancelBookingAction, rescheduleBookingAction } from "../../actions";
import { Badge, Flash, button, buttonSecondary, card, input } from "../../_components/ui";
import { fmtDateTime, fmtTime, money } from "../../_lib/format";

const isDate = (s: unknown): s is LocalDate =>
  typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

export default async function BookingPage(props: PageProps<"/dashboard/bookings/[id]">) {
  const user = await requireUser();
  const { id } = await props.params;
  const sp = await props.searchParams;
  const [business, booking, { staff }] = await Promise.all([
    getBusiness(user.businessId),
    getBooking(user.businessId, id),
    getCatalog(user.businessId),
  ]);
  if (!booking) notFound();
  const tz = business.timezone;
  const active = booking.status === "CONFIRMED" || booking.status === "PENDING";
  const payment = await prisma.payment.findUnique({ where: { bookingId: booking.id } });

  const moveDate = isDate(sp.date) ? sp.date : toLocalDate(booking.startsAt, tz);
  const moveStaff = typeof sp.staff === "string" ? sp.staff : "";
  const slots = active
    ? await getAvailability({
        businessId: user.businessId,
        serviceId: booking.serviceId,
        staffId: moveStaff === "any" ? undefined : moveStaff || booking.staffId,
        from: moveDate,
        to: moveDate,
      })
    : [];

  return (
    <>
      <h1 className="flex items-center gap-3 text-xl font-semibold">
        Booking <Badge status={booking.status} />
      </h1>
      <Flash
        ok={typeof sp.ok === "string" ? sp.ok : undefined}
        error={typeof sp.error === "string" ? sp.error : undefined}
      />

      <section className={`${card} grid gap-2 text-sm sm:grid-cols-2`}>
        <div>
          <span className="text-zinc-500">When</span>
          <br />
          {fmtDateTime(booking.startsAt, tz)} – {fmtTime(booking.endsAt, tz)}
        </div>
        <div>
          <span className="text-zinc-500">Service</span>
          <br />
          {booking.service.name}, {booking.service.durationMin} min,{" "}
          {money(booking.service.priceCents, booking.service.currency)}
        </div>
        <div>
          <span className="text-zinc-500">Staff</span>
          <br />
          {booking.staff.name}
          {booking.resources[0] && ` · ${booking.resources.map((r) => r.resource.name).join(", ")}`}
        </div>
        <div>
          <span className="text-zinc-500">Customer</span>
          <br />
          {booking.customer.name ?? "—"} · {booking.customer.phone}
        </div>
        <div>
          <span className="text-zinc-500">Source</span>
          <br />
          {booking.source} · v{booking.version}
        </div>
        {booking.notes && (
          <div>
            <span className="text-zinc-500">Notes</span>
            <br />
            {booking.notes}
          </div>
        )}
        {booking.cancelledAt && (
          <div>
            <span className="text-zinc-500">Cancelled</span>
            <br />
            {fmtDateTime(booking.cancelledAt, tz)}
          </div>
        )}
      </section>

      {payment && (
        <section className={`${card} space-y-1 text-sm`}>
          <h2 className="font-medium">Deposit</h2>
          <p>
            {(payment.amountCents / 100).toFixed(2)} {payment.currency} ·{" "}
            <Badge status={payment.status} />
            {payment.paidAt && (
              <span className="text-zinc-500"> paid {fmtDateTime(payment.paidAt, tz)}</span>
            )}
            {payment.refundedAt && (
              <span className="text-zinc-500"> refunded {fmtDateTime(payment.refundedAt, tz)}</span>
            )}
          </p>
          {payment.status === "REQUIRES_PAYMENT" && payment.checkoutUrl && (
            <p>
              Payment link (held until{" "}
              {booking.holdExpiresAt ? fmtDateTime(booking.holdExpiresAt, tz) : "?"}):{" "}
              <a className="underline" href={payment.checkoutUrl}>
                open
              </a>
            </p>
          )}
          {payment.lastError && (
            <p className="text-red-700 dark:text-red-300">{payment.lastError}</p>
          )}
        </section>
      )}

      {active && (
        <>
          <section className={`${card} space-y-3`}>
            <h2 className="font-medium">Reschedule</h2>
            <form className="flex flex-wrap items-end gap-3">
              <label className="text-sm">
                Date
                <input
                  type="date"
                  name="date"
                  defaultValue={moveDate}
                  className={`${input} mt-1 block`}
                />
              </label>
              <label className="text-sm">
                Staff
                <select name="staff" defaultValue={moveStaff} className={`${input} mt-1 block`}>
                  <option value="">Keep {booking.staff.name}</option>
                  <option value="any">Any available</option>
                  {staff
                    .filter((s) => s.active && s.id !== booking.staffId)
                    .map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                </select>
              </label>
              <button className={buttonSecondary}>Show slots</button>
            </form>
            <div className="flex flex-wrap gap-2">
              {slots.length === 0 && (
                <p className="text-sm text-zinc-500">No free slots that day.</p>
              )}
              {slots.map((s) => (
                <form key={s.start.toISOString()} action={rescheduleBookingAction}>
                  <input type="hidden" name="id" value={booking.id} />
                  <input type="hidden" name="version" value={booking.version} />
                  <input type="hidden" name="startsAt" value={s.start.toISOString()} />
                  <input type="hidden" name="staff" value={moveStaff} />
                  <button className={`${buttonSecondary} font-mono`}>{fmtTime(s.start, tz)}</button>
                </form>
              ))}
            </div>
          </section>

          <form action={cancelBookingAction} className={card}>
            <input type="hidden" name="id" value={booking.id} />
            <input type="hidden" name="version" value={booking.version} />
            <button className={`${button} bg-red-700 hover:bg-red-600 dark:bg-red-300`}>
              Cancel booking
            </button>
          </form>
        </>
      )}
    </>
  );
}
