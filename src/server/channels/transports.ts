import { prisma } from "@/server/db/prisma";
import type { Channel } from "@/generated/prisma/client";
import type { Transport } from "./types";
import { sendWhatsApp } from "./whatsapp/api";

/**
 * One transport per channel. The simulator "sends" by doing nothing: the
 * inbound pipeline records the OUT message, which is what the dashboard shows.
 */

export const simulatorTransport: Transport = {
  channel: "SIMULATOR",
  send: async () => ({ providerMessageId: null }),
};

export const whatsappTransport: Transport = {
  channel: "WHATSAPP",
  async send(ctx, message) {
    const business = await prisma.business.findUniqueOrThrow({
      where: { id: ctx.businessId },
      select: { whatsappPhoneNumberId: true },
    });
    if (!business.whatsappPhoneNumberId) {
      throw new Error("business has no whatsappPhoneNumberId");
    }
    return sendWhatsApp(business.whatsappPhoneNumberId, ctx.phone, message);
  },
};

const transports: Record<Channel, Transport> = {
  SIMULATOR: simulatorTransport,
  WHATSAPP: whatsappTransport,
};

export function getTransport(channel: Channel): Transport {
  return transports[channel];
}

/** Tests swap a transport in to capture what would have been sent. */
export function setTransport(transport: Transport) {
  transports[transport.channel] = transport;
}
