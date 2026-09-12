import { z } from "zod";
import { env } from "@/env";
import { handleInboundMessage } from "@/server/channels/inbound";
import { businessIdBySlug, findOrCreateCustomer } from "@/server/customers";
import { prisma } from "@/server/db/prisma";
import { cancelBookingAndRefund, createBooking } from "@/server/bookings";
import { NotFoundError, SchedulingError } from "@/server/scheduling";
import { verifySha256Header } from "../signature";
import type { EventHandler, WebhookProvider } from "../types";

/**
 * The simulator provider: a stand-in external system that speaks the same
 * shape as a real one (HMAC-signed JSON, batched events, its own event ids),
 * so the whole reliability layer can be exercised without WhatsApp or Stripe.
 *
 * Body: { events: [{ id, type, data }] }
 * Header: x-signature: sha256=<hmac-sha256-hex of the raw body>
 *
 * Events:
 *   booking.requested  { clientRef, business, service, staff?, startsAt, customer: { phone, name? } }
 *   booking.cancelled  { clientRef }
 *   message.received   { business, from, name?, text } | { business, from, name?, reply: { id, title } }
 *                      a customer chat message, exactly as WhatsApp would deliver one
 * `clientRef` is the correlation key, which is what lets a cancel that arrives
 * before its create wait for it instead of failing.
 */

const envelope = z.object({
  events: z
    .array(
      z.object({
        id: z.string().min(1),
        type: z.string().min(1),
        data: z.record(z.string(), z.unknown()),
      }),
    )
    .min(1),
});

const requested = z.object({
  clientRef: z.string().min(1),
  business: z.string().min(1),
  service: z.string().uuid(),
  staff: z.string().uuid().optional(),
  startsAt: z.coerce.date(),
  customer: z.object({ phone: z.string().min(5), name: z.string().optional() }),
});

const cancelled = z.object({ clientRef: z.string().min(1) });

const received = z.object({
  business: z.string().min(1),
  from: z.string().regex(/^\+[1-9]\d{6,14}$/),
  name: z.string().optional(),
  text: z.string().optional(),
  reply: z.object({ id: z.string(), title: z.string() }).optional(),
});

export const simulatorProvider: WebhookProvider = {
  name: "simulator",
  verify: (rawBody, headers) =>
    verifySha256Header(env.WEBHOOK_SIMULATOR_SECRET, rawBody, headers.get("x-signature")),
  parse: (rawBody) =>
    envelope.parse(JSON.parse(rawBody)).events.map((e) => ({
      providerEventId: e.id,
      eventType: e.type,
      correlationKey:
        typeof e.data.clientRef === "string"
          ? e.data.clientRef
          : typeof e.data.from === "string"
            ? e.data.from
            : undefined,
      payload: e.data,
    })),
};

export const simulatorHandler: EventHandler = async (event) => {
  switch (event.eventType) {
    case "booking.requested": {
      const p = requested.safeParse(event.payload);
      if (!p.success) return { kind: "reject", reason: `invalid payload: ${p.error.message}` };
      try {
        const businessId = await businessIdBySlug(p.data.business);
        const customer = await findOrCreateCustomer(
          businessId,
          p.data.customer.phone,
          p.data.customer.name,
        );
        const { booking, payment } = await createBooking({
          businessId,
          serviceId: p.data.service,
          staffId: p.data.staff,
          customerId: customer.id,
          startsAt: p.data.startsAt,
          source: "SIMULATOR",
        });
        return {
          kind: "processed",
          result: {
            bookingId: booking.id,
            staffId: booking.staffId,
            status: booking.status,
            paymentUrl: payment?.url,
          },
        };
      } catch (err) {
        // A business "no" is final for this event; anything else may be transient.
        if (err instanceof SchedulingError) return { kind: "skipped", reason: err.message };
        throw err;
      }
    }

    case "booking.cancelled": {
      const p = cancelled.safeParse(event.payload);
      if (!p.success) return { kind: "reject", reason: `invalid payload: ${p.error.message}` };
      // The create is the sibling with the same correlation key.
      const create = await prisma.inboundEvent.findFirst({
        where: {
          provider: event.provider,
          correlationKey: p.data.clientRef,
          eventType: "booking.requested",
          status: "PROCESSED",
        },
        select: { result: true },
      });
      const bookingId = (create?.result as { bookingId?: string } | null)?.bookingId;
      if (!bookingId)
        return { kind: "defer", reason: `no processed booking for ${p.data.clientRef} yet` };
      try {
        const booking = await prisma.booking.findUniqueOrThrow({
          where: { id: bookingId },
          select: { businessId: true },
        });
        const cancelled = await cancelBookingAndRefund({
          businessId: booking.businessId,
          bookingId,
          refundPolicy: "apply",
        });
        return { kind: "processed", result: { bookingId, status: cancelled.status } };
      } catch (err) {
        if (err instanceof NotFoundError || err instanceof SchedulingError) {
          return { kind: "skipped", reason: err.message };
        }
        throw err;
      }
    }

    case "message.received": {
      const p = received.safeParse(event.payload);
      if (!p.success) return { kind: "reject", reason: `invalid payload: ${p.error.message}` };
      const businessId = await businessIdBySlug(p.data.business);
      const result = await handleInboundMessage({
        businessId,
        channel: "SIMULATOR",
        phone: p.data.from,
        name: p.data.name,
        message: p.data.reply
          ? {
              kind: "button_reply",
              text: p.data.reply.title,
              replyId: p.data.reply.id,
              providerMessageId: event.providerEventId,
            }
          : { kind: "text", text: p.data.text ?? "", providerMessageId: event.providerEventId },
      });
      return { kind: "processed", result };
    }

    default:
      return { kind: "skipped", reason: `unhandled event type ${event.eventType}` };
  }
};
