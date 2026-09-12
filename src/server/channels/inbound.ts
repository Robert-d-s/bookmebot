import type { Channel, Prisma } from "@/generated/prisma/client";
import { findOrCreateCustomer } from "@/server/customers";
import { prisma } from "@/server/db/prisma";
import { respond } from "@/server/conversation/respond";
import { getTransport } from "./transports";
import type { InboundMessage, OutboundMessage } from "./types";

/**
 * The channel-neutral inbound pipeline, called by both webhook handlers:
 *   phone -> customer (created on first contact)
 *   persist IN message (idempotent on provider message id)
 *   ask the conversation layer for replies
 *   send each reply through the channel's transport and persist it as OUT
 */
export interface InboundArgs {
  businessId: string;
  channel: Channel;
  phone: string;
  name?: string;
  message: InboundMessage;
}

export async function handleInboundMessage(args: InboundArgs) {
  const customer = await findOrCreateCustomer(args.businessId, args.phone, args.name);

  const existing = await prisma.message.findUnique({
    where: {
      channel_providerMessageId: {
        channel: args.channel,
        providerMessageId: args.message.providerMessageId,
      },
    },
    select: { id: true },
  });
  if (existing) return { customerId: customer.id, duplicate: true, replies: 0 };

  await prisma.message.create({
    data: {
      businessId: args.businessId,
      customerId: customer.id,
      channel: args.channel,
      direction: "IN",
      kind: args.message.kind,
      text: args.message.text,
      payload: (args.message.replyId
        ? { replyId: args.message.replyId }
        : (args.message.payload ?? undefined)) as Prisma.InputJsonValue | undefined,
      providerMessageId: args.message.providerMessageId,
    },
  });

  const replies = await respond({
    businessId: args.businessId,
    customer: { id: customer.id, name: customer.name },
    message: args.message,
  });

  const transport = getTransport(args.channel);
  for (const reply of replies) {
    const sent = await transport.send({ businessId: args.businessId, phone: args.phone }, reply);
    await recordOutbound(args.businessId, customer.id, args.channel, reply, sent.providerMessageId);
  }
  return { customerId: customer.id, duplicate: false, replies: replies.length };
}

export async function recordOutbound(
  businessId: string,
  customerId: string,
  channel: Channel,
  message: OutboundMessage,
  providerMessageId: string | null,
) {
  const { kind, text, ...rest } = message;
  return prisma.message.create({
    data: {
      businessId,
      customerId,
      channel,
      direction: "OUT",
      kind,
      text,
      payload: Object.keys(rest).length ? (rest as Prisma.InputJsonValue) : undefined,
      providerMessageId,
    },
  });
}
