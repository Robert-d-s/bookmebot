import { notFound } from "next/navigation";
import { manageUrl, verifyBookingToken } from "@/server/bookings/token";
import { prisma } from "@/server/db/prisma";

const fmt = (d: Date, tz: string) =>
  new Intl.DateTimeFormat("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: tz,
  }).format(d);

export default async function DonePage(props: PageProps<"/book/[slug]/done">) {
  const { slug } = await props.params;
  const sp = await props.searchParams;
  const id = typeof sp.id === "string" ? sp.id : "";
  if (!verifyBookingToken(id, typeof sp.t === "string" ? sp.t : null)) notFound();
  const booking = await prisma.booking.findFirst({
    where: { id, business: { slug } },
    include: { service: true, staff: true, business: true },
  });
  if (!booking) notFound();
  return (
    <main className="mx-auto w-full max-w-lg flex-1 space-y-4 p-6">
      <h1 className="text-2xl font-semibold">
        {booking.status === "CONFIRMED"
          ? "You're booked"
          : `Booking ${booking.status.toLowerCase()}`}
      </h1>
      <p>
        <strong>{booking.service.name}</strong> with {booking.staff.name}
        <br />
        {fmt(booking.startsAt, booking.business.timezone)}
      </p>
      <p className="text-sm text-zinc-500">
        Keep this link to cancel:{" "}
        <a className="underline" href={manageUrl(slug, booking.id)}>
          manage booking
        </a>
      </p>
    </main>
  );
}
