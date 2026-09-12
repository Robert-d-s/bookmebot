"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { cancelBookingAndRefund, createBooking } from "@/server/bookings";
import { bookingToken, verifyBookingToken } from "@/server/bookings/token";
import { businessIdBySlug, findOrCreateCustomer } from "@/server/customers";
import { prisma } from "@/server/db/prisma";
import { SchedulingError } from "@/server/scheduling";

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();

/** Public booking form submit: no login, customer identified by phone. */
export async function publicBookAction(formData: FormData) {
  const slug = str(formData, "slug");
  const back = (msg: string): never =>
    redirect(
      `/book/${slug}?service=${str(formData, "service")}&date=${str(formData, "date")}&error=${encodeURIComponent(msg)}`,
    );
  let input;
  try {
    input = z
      .object({
        service: z.string().uuid(),
        startsAt: z.coerce.date(),
        phone: z
          .string()
          .regex(/^\+[1-9]\d{6,14}$/, "phone must be international, e.g. +40721000000"),
        name: z.string().min(1, "name is required").max(100),
        email: z.union([z.string().email("email looks wrong"), z.literal("")]),
      })
      .parse({
        service: str(formData, "service"),
        startsAt: str(formData, "startsAt"),
        phone: str(formData, "phone"),
        name: str(formData, "name"),
        email: str(formData, "email"),
      });
  } catch (err) {
    back(err instanceof z.ZodError ? err.issues.map((i) => i.message).join("; ") : "invalid input");
  }
  try {
    const businessId = await businessIdBySlug(slug);
    const customer = await findOrCreateCustomer(
      businessId,
      input!.phone,
      input!.name,
      input!.email || undefined,
    );
    const { booking, payment } = await createBooking({
      businessId,
      serviceId: input!.service,
      customerId: customer.id,
      startsAt: input!.startsAt,
      source: "API",
    });
    if (payment) redirect(payment.url);
    redirect(`/book/${slug}/done?id=${booking.id}&t=${bookingToken(booking.id)}`);
  } catch (err) {
    if (isRedirect(err)) throw err;
    back(
      err instanceof SchedulingError
        ? "reason" in err
          ? `that time is no longer available (${String(err.reason).toLowerCase().replace(/_/g, " ")})`
          : err.message
        : "something went wrong",
    );
  }
}

/** Customer cancels from their manage link; the refund cutoff applies. */
export async function publicCancelAction(formData: FormData) {
  const slug = str(formData, "slug");
  const id = str(formData, "id");
  const t = str(formData, "t");
  if (!verifyBookingToken(id, t)) redirect(`/book/${slug}/manage?id=${id}&t=${t}&error=bad-link`);
  const booking = await prisma.booking.findFirst({
    where: { id, business: { slug } },
    select: { businessId: true },
  });
  if (!booking) redirect(`/book/${slug}/manage?id=${id}&t=${t}&error=not-found`);
  try {
    const r = await cancelBookingAndRefund({
      businessId: booking!.businessId,
      bookingId: id,
      refundPolicy: "apply",
    });
    redirect(`/book/${slug}/manage?id=${id}&t=${t}&ok=${r.deposit ?? "NONE"}`);
  } catch (err) {
    if (isRedirect(err)) throw err;
    redirect(
      `/book/${slug}/manage?id=${id}&t=${t}&error=${encodeURIComponent(err instanceof Error ? err.message : "failed")}`,
    );
  }
}

function isRedirect(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "digest" in err &&
    String((err as { digest: unknown }).digest).startsWith("NEXT_REDIRECT")
  );
}
