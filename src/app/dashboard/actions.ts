"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireUser } from "@/server/auth/session";
import { findOrCreateCustomer } from "@/server/customers";
import { prisma } from "@/server/db/prisma";
import { cancelBookingAndRefund, createBooking } from "@/server/bookings";
import { pushSoon } from "@/server/calendar/sync";
import { SchedulingError, rescheduleBooking } from "@/server/scheduling";
import { replayEvent } from "@/server/webhooks";
import { hhmmToMinutes } from "./_lib/format";

/**
 * Server actions for the owner dashboard. Each one: require a session, parse
 * the form with zod, call the domain layer, then revalidate or redirect.
 * Failures become `?error=` on the page the form lives on.
 */

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();
const uuid = z.string().uuid();
const fail = (path: string, message: string): never =>
  redirect(`${path}${path.includes("?") ? "&" : "?"}error=${encodeURIComponent(message)}`);
const describe = (err: unknown) =>
  err instanceof SchedulingError
    ? "reason" in err
      ? `Slot unavailable: ${String(err.reason)}`
      : err.message
    : err instanceof z.ZodError
      ? err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")
      : "Something went wrong";

// --- bookings ----------------------------------------------------------------

export async function createBookingAction(formData: FormData) {
  const user = await requireUser();
  const back = `/dashboard/bookings/new?service=${str(formData, "service")}&staff=${str(formData, "staff")}&date=${str(formData, "date")}`;
  try {
    const input = z
      .object({
        service: uuid,
        staff: z.union([uuid, z.literal("")]),
        startsAt: z.coerce.date(),
        phone: z.string().regex(/^\+[1-9]\d{6,14}$/, "E.164 phone expected, e.g. +40721000000"),
        name: z.string().max(100),
        notes: z.string().max(500),
      })
      .parse({
        service: str(formData, "service"),
        staff: str(formData, "staff"),
        startsAt: str(formData, "startsAt"),
        phone: str(formData, "phone"),
        name: str(formData, "name"),
        notes: str(formData, "notes"),
      });
    const customer = await findOrCreateCustomer(
      user.businessId,
      input.phone,
      input.name || undefined,
    );
    // The owner books in person: no deposit is collected.
    const { booking } = await createBooking({
      businessId: user.businessId,
      serviceId: input.service,
      staffId: input.staff || undefined,
      customerId: customer.id,
      startsAt: input.startsAt,
      notes: input.notes || undefined,
      source: "DASHBOARD",
      collectDeposit: false,
    });
    revalidatePath("/dashboard");
    redirect(`/dashboard/bookings/${booking.id}?ok=Booking+created`);
  } catch (err) {
    if (isRedirect(err)) throw err;
    fail(back, describe(err));
  }
}

export async function cancelBookingAction(formData: FormData) {
  const user = await requireUser();
  const id = uuid.parse(str(formData, "id"));
  try {
    await cancelBookingAndRefund({
      businessId: user.businessId,
      bookingId: id,
      expectedVersion: Number(str(formData, "version")) || undefined,
    });
  } catch (err) {
    fail(`/dashboard/bookings/${id}`, describe(err));
  }
  revalidatePath("/dashboard");
  redirect(`/dashboard/bookings/${id}?ok=Booking+cancelled`);
}

export async function rescheduleBookingAction(formData: FormData) {
  const user = await requireUser();
  const id = uuid.parse(str(formData, "id"));
  try {
    const input = z
      .object({
        startsAt: z.coerce.date(),
        staff: z.union([uuid, z.literal("any"), z.literal("")]),
        version: z.coerce.number().int().optional(),
      })
      .parse({
        startsAt: str(formData, "startsAt"),
        staff: str(formData, "staff"),
        version: str(formData, "version") || undefined,
      });
    await rescheduleBooking({
      businessId: user.businessId,
      bookingId: id,
      startsAt: input.startsAt,
      staffId: input.staff || undefined,
      expectedVersion: input.version,
    });
  } catch (err) {
    fail(`/dashboard/bookings/${id}`, describe(err));
  }
  pushSoon(id);
  revalidatePath("/dashboard");
  redirect(`/dashboard/bookings/${id}?ok=Booking+moved`);
}

// --- settings ----------------------------------------------------------------

export async function saveBusinessSettingsAction(formData: FormData) {
  const user = await requireUser();
  try {
    const input = z
      .object({
        refundCutoffHours: z.coerce
          .number()
          .int()
          .min(0)
          .max(24 * 30),
        minLeadMin: z.coerce
          .number()
          .int()
          .min(0)
          .max(24 * 60 * 7),
        maxAdvanceDays: z.coerce.number().int().min(1).max(365),
      })
      .parse({
        refundCutoffHours: str(formData, "refundCutoffHours"),
        minLeadMin: str(formData, "minLeadMin"),
        maxAdvanceDays: str(formData, "maxAdvanceDays"),
      });
    await prisma.business.update({ where: { id: user.businessId }, data: input });
  } catch (err) {
    fail("/dashboard/settings", describe(err));
  }
  revalidatePath("/dashboard/settings");
  redirect("/dashboard/settings?ok=Settings+saved");
}

export async function saveBusinessHoursAction(formData: FormData) {
  const user = await requireUser();
  const rules = [];
  for (let weekday = 0; weekday < 7; weekday++) {
    if (!formData.get(`open_${weekday}`)) continue;
    const startMin = hhmmToMinutes(str(formData, `start_${weekday}`));
    const endMin = hhmmToMinutes(str(formData, `end_${weekday}`));
    if (!(startMin >= 0 && endMin <= 1440 && startMin < endMin)) {
      fail("/dashboard/settings", `Invalid hours for weekday ${weekday}`);
    }
    rules.push({ businessId: user.businessId, weekday, startMin, endMin });
  }
  await prisma.$transaction([
    prisma.availabilityRule.deleteMany({ where: { businessId: user.businessId, staffId: null } }),
    prisma.availabilityRule.createMany({ data: rules }),
  ]);
  revalidatePath("/dashboard/settings");
  redirect("/dashboard/settings?ok=Hours+saved");
}

const serviceSchema = z.object({
  name: z.string().min(1).max(100),
  durationMin: z.coerce.number().int().min(5).max(600),
  priceCents: z.coerce.number().int().min(0),
  bufferBeforeMin: z.coerce.number().int().min(0).max(120),
  bufferAfterMin: z.coerce.number().int().min(0).max(120),
  requiredResourceType: z.enum(["", "CHAIR", "ROOM", "BAY", "STATION"]),
  depositCents: z.coerce.number().int().min(0),
  active: z.boolean(),
});

export async function saveServiceAction(formData: FormData) {
  const user = await requireUser();
  const id = str(formData, "id");
  try {
    const s = serviceSchema.parse({
      name: str(formData, "name"),
      durationMin: str(formData, "durationMin"),
      priceCents: Math.round(Number(str(formData, "price")) * 100),
      bufferBeforeMin: str(formData, "bufferBeforeMin") || 0,
      bufferAfterMin: str(formData, "bufferAfterMin") || 0,
      requiredResourceType: str(formData, "requiredResourceType"),
      depositCents: Math.round(Number(str(formData, "deposit") || 0) * 100),
      active: formData.get("active") === "on",
    });
    const data = { ...s, requiredResourceType: s.requiredResourceType || null };
    if (id) {
      await prisma.service.update({ where: { id, businessId: user.businessId }, data });
    } else {
      // New services are offered by every active staff member until edited.
      const staff = await prisma.staff.findMany({
        where: { businessId: user.businessId, active: true },
        select: { id: true },
      });
      await prisma.service.create({
        data: {
          ...data,
          businessId: user.businessId,
          staff: { create: staff.map((x) => ({ staffId: x.id })) },
        },
      });
    }
  } catch (err) {
    fail("/dashboard/settings", describe(err));
  }
  revalidatePath("/dashboard/settings");
  redirect("/dashboard/settings?ok=Service+saved");
}

export async function toggleServiceStaffAction(formData: FormData) {
  const user = await requireUser();
  const serviceId = uuid.parse(str(formData, "serviceId"));
  const staffId = uuid.parse(str(formData, "staffId"));
  const [service, staff] = await Promise.all([
    prisma.service.findFirst({ where: { id: serviceId, businessId: user.businessId } }),
    prisma.staff.findFirst({ where: { id: staffId, businessId: user.businessId } }),
  ]);
  if (!service || !staff) fail("/dashboard/settings", "Not found");
  const key = { serviceId_staffId: { serviceId, staffId } };
  const existing = await prisma.serviceStaff.findUnique({ where: key });
  if (existing) await prisma.serviceStaff.delete({ where: key });
  else await prisma.serviceStaff.create({ data: { serviceId, staffId } });
  revalidatePath("/dashboard/settings");
}

export async function createStaffAction(formData: FormData) {
  const user = await requireUser();
  const name = z.string().min(1).max(100).parse(str(formData, "name"));
  const services = await prisma.service.findMany({
    where: { businessId: user.businessId, active: true },
    select: { id: true },
  });
  await prisma.staff.create({
    data: {
      businessId: user.businessId,
      name,
      services: { create: services.map((s) => ({ serviceId: s.id })) },
    },
  });
  revalidatePath("/dashboard/settings");
  redirect("/dashboard/settings?ok=Staff+added");
}

export async function toggleStaffAction(formData: FormData) {
  const user = await requireUser();
  const id = uuid.parse(str(formData, "id"));
  const staff = await prisma.staff.findFirst({ where: { id, businessId: user.businessId } });
  if (staff) {
    await prisma.staff.update({ where: { id }, data: { active: !staff.active } });
  }
  revalidatePath("/dashboard/settings");
}

export async function createResourceAction(formData: FormData) {
  const user = await requireUser();
  const input = z
    .object({ name: z.string().min(1).max(100), type: z.enum(["CHAIR", "ROOM", "BAY", "STATION"]) })
    .parse({ name: str(formData, "name"), type: str(formData, "type") });
  await prisma.resource.create({ data: { businessId: user.businessId, ...input } });
  revalidatePath("/dashboard/settings");
  redirect("/dashboard/settings?ok=Resource+added");
}

export async function toggleResourceAction(formData: FormData) {
  const user = await requireUser();
  const id = uuid.parse(str(formData, "id"));
  const r = await prisma.resource.findFirst({ where: { id, businessId: user.businessId } });
  if (r) await prisma.resource.update({ where: { id }, data: { active: !r.active } });
  revalidatePath("/dashboard/settings");
}

// --- conversations -------------------------------------------------------------

export async function setConversationModeAction(formData: FormData) {
  const user = await requireUser();
  const customerId = uuid.parse(str(formData, "customerId"));
  const mode = z.enum(["BOT", "HUMAN"]).parse(str(formData, "mode"));
  const customer = await prisma.customer.findFirst({
    where: { id: customerId, businessId: user.businessId },
  });
  if (!customer) fail("/dashboard/customers", "Not found");
  await prisma.conversation.upsert({
    where: { customerId },
    create: { businessId: user.businessId, customerId, mode },
    update: { mode },
  });
  revalidatePath(`/dashboard/customers/${customerId}`);
}

// --- events ------------------------------------------------------------------

export async function replayEventAction(formData: FormData) {
  await requireUser();
  const id = uuid.parse(str(formData, "id"));
  await replayEvent(id);
  revalidatePath("/dashboard/events");
}

function isRedirect(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "digest" in err &&
    String((err as { digest: unknown }).digest).startsWith("NEXT_REDIRECT")
  );
}
