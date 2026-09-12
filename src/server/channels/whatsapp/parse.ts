import { z } from "zod";
import type { ParsedEvent } from "@/server/webhooks/types";
import type { InboundMessage } from "../types";

/**
 * Meta Cloud API webhook payload -> our events. One POST can carry several
 * messages and delivery statuses across several phone numbers.
 * Shape reference: developers.facebook.com/docs/whatsapp/cloud-api/webhooks/payload-examples
 */

const message = z
  .object({
    id: z.string(),
    from: z.string(),
    timestamp: z.string(),
    type: z.string(),
    text: z.object({ body: z.string() }).optional(),
    interactive: z
      .object({
        type: z.string(),
        button_reply: z.object({ id: z.string(), title: z.string() }).optional(),
        list_reply: z
          .object({ id: z.string(), title: z.string(), description: z.string().optional() })
          .optional(),
      })
      .optional(),
  })
  .passthrough();

const status = z
  .object({ id: z.string(), status: z.string(), timestamp: z.string(), recipient_id: z.string() })
  .passthrough();

const value = z.object({
  messaging_product: z.literal("whatsapp"),
  metadata: z.object({ display_phone_number: z.string(), phone_number_id: z.string() }),
  contacts: z
    .array(z.object({ profile: z.object({ name: z.string() }), wa_id: z.string() }))
    .optional(),
  messages: z.array(message).optional(),
  statuses: z.array(status).optional(),
});

const envelope = z.object({
  object: z.literal("whatsapp_business_account"),
  entry: z.array(
    z.object({
      id: z.string(),
      changes: z.array(z.object({ field: z.string(), value: value })),
    }),
  ),
});

export type WhatsAppMessageEvent = {
  phoneNumberId: string;
  from: string; // E.164 with "+"
  name?: string;
  message: InboundMessage;
};

export type WhatsAppStatusEvent = {
  phoneNumberId: string;
  messageId: string;
  status: string;
  recipient: string;
};

/** Meta sends wa_id / from as digits only. */
export const toE164 = (digits: string) => (digits.startsWith("+") ? digits : `+${digits}`);

export function normaliseMessage(m: z.infer<typeof message>): InboundMessage {
  if (m.type === "text" && m.text) {
    return { kind: "text", text: m.text.body, providerMessageId: m.id };
  }
  if (m.type === "interactive" && m.interactive?.button_reply) {
    const r = m.interactive.button_reply;
    return { kind: "button_reply", text: r.title, replyId: r.id, providerMessageId: m.id };
  }
  if (m.type === "interactive" && m.interactive?.list_reply) {
    const r = m.interactive.list_reply;
    return { kind: "list_reply", text: r.title, replyId: r.id, providerMessageId: m.id };
  }
  return { kind: "unsupported", text: null, providerMessageId: m.id, payload: m };
}

/** Throws on a body that is not a WhatsApp webhook; the webhook layer answers 400. */
export function parseWhatsAppWebhook(rawBody: string): ParsedEvent[] {
  const body = envelope.parse(JSON.parse(rawBody));
  const events: ParsedEvent[] = [];
  for (const entry of body.entry) {
    for (const change of entry.changes) {
      const v = change.value;
      const names = new Map(v.contacts?.map((c) => [c.wa_id, c.profile.name]) ?? []);
      for (const m of v.messages ?? []) {
        const payload: WhatsAppMessageEvent = {
          phoneNumberId: v.metadata.phone_number_id,
          from: toE164(m.from),
          name: names.get(m.from),
          message: normaliseMessage(m),
        };
        events.push({
          providerEventId: m.id,
          eventType: "message",
          correlationKey: payload.from,
          payload,
        });
      }
      for (const s of v.statuses ?? []) {
        const payload: WhatsAppStatusEvent = {
          phoneNumberId: v.metadata.phone_number_id,
          messageId: s.id,
          status: s.status,
          recipient: toE164(s.recipient_id),
        };
        events.push({
          providerEventId: `${s.id}:${s.status}`,
          eventType: "status",
          correlationKey: payload.recipient,
          payload,
        });
      }
    }
  }
  return events;
}
