import type { Channel } from "@/generated/prisma/client";
import type { InboundMessage, OutboundMessage } from "@/server/channels/types";
import { runAgent } from "./agent";
import { decodeReply } from "./buttons";

/**
 * Conversation layer entry point, called by the channel pipeline. Turns the
 * inbound message into text the agent understands (button taps become
 * sentences) and runs one agent turn.
 */
export interface RespondArgs {
  businessId: string;
  customer: { id: string; name: string | null };
  channel: Channel;
  message: InboundMessage;
  now?: Date;
}

export async function respond(args: RespondArgs): Promise<OutboundMessage[]> {
  const m = args.message;
  const userText =
    m.kind === "button_reply" || m.kind === "list_reply"
      ? decodeReply(m.replyId ?? "", m.text ?? "")
      : m.kind === "unsupported"
        ? "[the customer sent something that is not text]"
        : (m.text ?? "");
  return runAgent({
    businessId: args.businessId,
    customer: args.customer,
    channel: args.channel,
    userText,
    now: args.now,
  });
}
