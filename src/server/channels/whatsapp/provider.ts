import { env } from "@/env";
import { prisma } from "@/server/db/prisma";
import { verifySha256Header } from "@/server/webhooks/signature";
import type { EventHandler, WebhookProvider } from "@/server/webhooks/types";
import { handleInboundMessage } from "../inbound";
import { type WhatsAppMessageEvent, parseWhatsAppWebhook } from "./parse";

/**
 * WhatsApp Cloud API as a webhook provider. Signature is HMAC-SHA256 of the
 * raw body with the Meta app secret, in `X-Hub-Signature-256: sha256=<hex>`;
 * endpoint verification is a GET with hub.mode/hub.verify_token/hub.challenge.
 */
export const whatsappProvider: WebhookProvider = {
  name: "whatsapp",
  verify: (rawBody, headers) =>
    env.WHATSAPP_APP_SECRET
      ? verifySha256Header(env.WHATSAPP_APP_SECRET, rawBody, headers.get("x-hub-signature-256"))
      : false,
  parse: parseWhatsAppWebhook,
  challenge: (url) => {
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");
    if (mode !== "subscribe" || !challenge) return null;
    if (!env.WHATSAPP_VERIFY_TOKEN || token !== env.WHATSAPP_VERIFY_TOKEN) {
      return new Response("forbidden", { status: 403 });
    }
    return new Response(challenge, { status: 200, headers: { "content-type": "text/plain" } });
  },
};

export const whatsappHandler: EventHandler = async (event) => {
  if (event.eventType === "status") {
    return { kind: "skipped", reason: "delivery status noted" };
  }
  if (event.eventType !== "message") {
    return { kind: "skipped", reason: `unhandled event type ${event.eventType}` };
  }
  const p = event.payload as unknown as WhatsAppMessageEvent;
  const business = await prisma.business.findUnique({
    where: { whatsappPhoneNumberId: p.phoneNumberId },
    select: { id: true },
  });
  if (!business) {
    return { kind: "reject", reason: `no business for phone_number_id ${p.phoneNumberId}` };
  }
  const result = await handleInboundMessage({
    businessId: business.id,
    channel: "WHATSAPP",
    phone: p.from,
    name: p.name,
    message: p.message,
  });
  return { kind: "processed", result };
};
