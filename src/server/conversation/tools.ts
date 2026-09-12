import { randomUUID } from "node:crypto";
import type { BookingSource, Channel } from "@/generated/prisma/client";
import { prisma } from "@/server/db/prisma";
import { cancelBookingAndRefund, createBooking } from "@/server/bookings";
import { SchedulingError, getAvailability, rescheduleBooking } from "@/server/scheduling";
import { type LocalDate, toLocalDate } from "@/server/scheduling/time";
import type { ToolDef } from "./llm/types";
import type { ConversationState } from "./state";

/**
 * The tools the model may call. Every write goes through the scheduling
 * engine, which decides; the model only proposes. Two guardrails are
 * enforced here, not in the prompt:
 *   1. a booking needs propose_booking first, then confirm_booking
 *   2. confirm_booking only works in a LATER customer turn than the proposal,
 *      so the customer has always seen and answered the proposal
 */

export interface ToolContext {
  businessId: string;
  customer: { id: string; name: string | null };
  channel: Channel;
  timezone: string;
  state: ConversationState;
  now: Date;
}

const date = { type: "string", description: "Local calendar date, YYYY-MM-DD" };
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

export const TOOL_DEFS: ToolDef[] = [
  {
    name: "list_services",
    description:
      "Services with ids, durations and prices. Call before proposing a service the customer named.",
    inputSchema: obj({}),
  },
  {
    name: "get_opening_hours",
    description: "Weekly opening hours as human-readable lines.",
    inputSchema: obj({}),
  },
  {
    name: "get_availability",
    description:
      "Bookable start times for a service on one local date, optionally for one staff member. Returns a sample of up to 8 starts plus the total.",
    inputSchema: obj({ service_id: { type: "string" }, date, staff_id: { type: "string" } }, [
      "service_id",
      "date",
    ]),
  },
  {
    name: "propose_booking",
    description:
      "Check that a start time is still free and register it as a proposal. Then ASK the customer to confirm. Never claims a booking exists.",
    inputSchema: obj(
      {
        service_id: { type: "string" },
        start: { type: "string", description: "ISO 8601 start" },
        staff_id: { type: "string" },
      },
      ["service_id", "start"],
    ),
  },
  {
    name: "confirm_booking",
    description:
      "Create the booking for a proposal the customer has explicitly confirmed in their latest message. Fails if the proposal was made in this same turn. May return a payment url: then the booking is only held until the deposit is paid.",
    inputSchema: obj({ proposal_id: { type: "string" } }, ["proposal_id"]),
  },
  {
    name: "list_my_bookings",
    description: "The customer's upcoming bookings with ids.",
    inputSchema: obj({}),
  },
  {
    name: "cancel_booking",
    description:
      "Cancel one of the customer's own bookings. Ask first unless the customer already named it.",
    inputSchema: obj({ booking_id: { type: "string" } }, ["booking_id"]),
  },
  {
    name: "reschedule_booking",
    description:
      "Move one of the customer's own bookings to a new ISO start; the engine checks the slot.",
    inputSchema: obj({ booking_id: { type: "string" }, start: { type: "string" } }, [
      "booking_id",
      "start",
    ]),
  },
  {
    name: "handoff",
    description:
      "Stop the bot for this customer and let a person take over. Use for complaints or anything outside bookings.",
    inputSchema: obj({ reason: { type: "string" } }, ["reason"]),
  },
];

const fmt = (d: Date, tz: string) =>
  new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: tz,
  }).format(d);
const price = (cents: number, currency: string) => `${(cents / 100).toFixed(0)} ${currency}`;
const SOURCE: Record<Channel, BookingSource> = { WHATSAPP: "WHATSAPP", SIMULATOR: "SIMULATOR" };
const PROPOSAL_TTL_MS = 30 * 60_000;

export class ToolError extends Error {}

/** Executes one tool call. Throws ToolError for "tell the customer" failures. */
export async function executeTool(
  name: string,
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<unknown> {
  const str = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : undefined);
  switch (name) {
    case "list_services": {
      const services = await prisma.service.findMany({
        where: { businessId: ctx.businessId, active: true },
        orderBy: { name: "asc" },
      });
      return {
        services: services.map((s) => ({
          id: s.id,
          name: s.name,
          durationMin: s.durationMin,
          price: price(s.priceCents, s.currency),
        })),
      };
    }
    case "get_opening_hours": {
      const rules = await prisma.availabilityRule.findMany({
        where: { businessId: ctx.businessId, staffId: null },
        orderBy: [{ weekday: "asc" }, { startMin: "asc" }],
      });
      const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
      const hhmm = (m: number) =>
        `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
      return {
        lines: days.map((d, i) => {
          const r = rules.filter((x) => x.weekday === i);
          return `${d}: ${r.length ? r.map((x) => `${hhmm(x.startMin)}–${hhmm(x.endMin)}`).join(", ") : "closed"}`;
        }),
      };
    }
    case "get_availability": {
      const serviceId = str("service_id");
      const day = str("date");
      if (!serviceId || !day || !/^\d{4}-\d{2}-\d{2}$/.test(day))
        throw new ToolError("service_id and date (YYYY-MM-DD) are required");
      const slots = await wrap(() =>
        getAvailability({
          businessId: ctx.businessId,
          serviceId,
          staffId: str("staff_id"),
          from: day as LocalDate,
          to: day as LocalDate,
          now: ctx.now,
        }),
      );
      const sample = spread(slots, 8);
      return {
        date: day,
        total: slots.length,
        slots: sample.map((s) => ({
          start: s.start.toISOString(),
          label: fmt(s.start, ctx.timezone),
          staff_ids: s.staffIds,
          service_id: serviceId,
        })),
      };
    }
    case "propose_booking": {
      const serviceId = str("service_id");
      const start = str("start");
      if (!serviceId || !start || Number.isNaN(Date.parse(start)))
        throw new ToolError("service_id and an ISO start are required");
      const startsAt = new Date(start);
      const day = toLocalDate(startsAt, ctx.timezone);
      const staffId = str("staff_id");
      const [slots, service] = await Promise.all([
        wrap(() =>
          getAvailability({
            businessId: ctx.businessId,
            serviceId,
            staffId,
            from: day,
            to: day,
            now: ctx.now,
          }),
        ),
        prisma.service.findFirst({
          where: { id: serviceId, businessId: ctx.businessId },
          select: { name: true },
        }),
      ]);
      const slot = slots.find((s) => s.start.getTime() === startsAt.getTime());
      if (!slot || !service) throw new ToolError("that time is not available");
      const chosenStaff = staffId ?? slot.staffIds[0];
      const staff = await prisma.staff.findUnique({
        where: { id: chosenStaff },
        select: { name: true },
      });
      const proposal = {
        id: randomUUID().slice(0, 8),
        serviceId,
        staffId,
        start: startsAt.toISOString(),
        turn: ctx.state.turn,
        createdAt: ctx.now.toISOString(),
      };
      ctx.state.proposal = proposal;
      return {
        proposal_id: proposal.id,
        service: service.name,
        when: fmt(startsAt, ctx.timezone),
        staff: staffId ? staff?.name : `${staff?.name ?? "any"} (or any available)`,
        needs_confirmation: true,
      };
    }
    case "confirm_booking": {
      const p = ctx.state.proposal;
      const id = str("proposal_id");
      if (!p || p.id !== id) throw new ToolError("no such proposal; propose a time first");
      if (p.turn >= ctx.state.turn)
        throw new ToolError("the customer has not answered the proposal yet; ask them to confirm");
      if (ctx.now.getTime() - Date.parse(p.createdAt) > PROPOSAL_TTL_MS)
        throw new ToolError("the proposal expired; check availability again");
      const { booking, payment } = await wrap(() =>
        createBooking({
          businessId: ctx.businessId,
          serviceId: p.serviceId,
          staffId: p.staffId,
          customerId: ctx.customer.id,
          startsAt: new Date(p.start),
          source: SOURCE[ctx.channel],
          now: ctx.now,
        }),
      );
      ctx.state.proposal = undefined;
      const [service, staff] = await Promise.all([
        prisma.service.findUniqueOrThrow({
          where: { id: booking.serviceId },
          select: { name: true },
        }),
        prisma.staff.findUniqueOrThrow({ where: { id: booking.staffId }, select: { name: true } }),
      ]);
      return {
        booking_id: booking.id,
        status: booking.status,
        service: service.name,
        when: fmt(booking.startsAt, ctx.timezone),
        staff: staff.name,
        ...(payment
          ? {
              payment: {
                url: payment.url,
                amount: price(payment.amountCents, payment.currency),
                hold_minutes: Math.round(
                  (payment.expiresAt.getTime() - ctx.now.getTime()) / 60_000,
                ),
              },
            }
          : {}),
      };
    }
    case "list_my_bookings": {
      const bookings = await prisma.booking.findMany({
        where: {
          businessId: ctx.businessId,
          customerId: ctx.customer.id,
          status: { in: ["PENDING", "CONFIRMED"] },
          startsAt: { gte: ctx.now },
        },
        orderBy: { startsAt: "asc" },
        take: 10,
        include: { service: { select: { name: true } }, staff: { select: { name: true } } },
      });
      return {
        bookings: bookings.map((b) => ({
          booking_id: b.id,
          service: b.service.name,
          staff: b.staff.name,
          when: fmt(b.startsAt, ctx.timezone),
          start: b.startsAt.toISOString(),
        })),
      };
    }
    case "cancel_booking": {
      const bookingId = str("booking_id");
      const own =
        bookingId &&
        (await prisma.booking.findFirst({
          where: { id: bookingId, businessId: ctx.businessId, customerId: ctx.customer.id },
          include: { service: { select: { name: true } } },
        }));
      if (!own) throw new ToolError("no such booking");
      const b = await wrap(() =>
        cancelBookingAndRefund({ businessId: ctx.businessId, bookingId: own.id, now: ctx.now }),
      );
      return {
        booking_id: b.id,
        status: b.status,
        service: own.service.name,
        when: fmt(own.startsAt, ctx.timezone),
      };
    }
    case "reschedule_booking": {
      const bookingId = str("booking_id");
      const start = str("start");
      const own =
        bookingId &&
        (await prisma.booking.findFirst({
          where: { id: bookingId, businessId: ctx.businessId, customerId: ctx.customer.id },
        }));
      if (!own || !start || Number.isNaN(Date.parse(start)))
        throw new ToolError("booking_id and an ISO start are required");
      const b = await wrap(() =>
        rescheduleBooking({
          businessId: ctx.businessId,
          bookingId: own.id,
          startsAt: new Date(start),
          now: ctx.now,
        }),
      );
      return { booking_id: b.id, status: b.status, when: fmt(b.startsAt, ctx.timezone) };
    }
    case "handoff": {
      await prisma.conversation.updateMany({
        where: { customerId: ctx.customer.id },
        data: { mode: "HUMAN" },
      });
      return { ok: true, message: "A person will continue this conversation." };
    }
    default:
      throw new ToolError(`unknown tool ${name}`);
  }
}

async function wrap<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof SchedulingError) {
      const reason =
        "reason" in err ? String(err.reason).toLowerCase().replace(/_/g, " ") : err.message;
      throw new ToolError(reason);
    }
    throw err;
  }
}

/** Up to n items evenly spread over the list, always including first and last. */
export function spread<T>(items: T[], n: number): T[] {
  if (items.length <= n) return items;
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(items[Math.round((i * (items.length - 1)) / (n - 1))]);
  return [...new Set(out)];
}
