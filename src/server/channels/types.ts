import type { Channel } from "@/generated/prisma/client";

/**
 * Channel-neutral message shapes. WhatsApp and the simulator both map to and
 * from these, so the conversation layer never sees a provider payload.
 */

export type OutboundMessage =
  | { kind: "text"; text: string }
  /** WhatsApp allows at most 3 reply buttons. */
  | { kind: "buttons"; text: string; buttons: { id: string; title: string }[] }
  /** Up to 10 rows on WhatsApp. `button` is the label that opens the list. */
  | {
      kind: "list";
      text: string;
      button: string;
      rows: { id: string; title: string; description?: string }[];
    };

export interface InboundMessage {
  kind: "text" | "button_reply" | "list_reply" | "unsupported";
  /** Body text, or the chosen option's title. */
  text: string | null;
  /** Option id for button_reply / list_reply. */
  replyId?: string;
  providerMessageId: string;
  /** Raw provider message for unsupported kinds (images, audio, ...). */
  payload?: unknown;
}

export interface SendContext {
  businessId: string;
  /** E.164 phone of the customer. */
  phone: string;
}

/** How replies leave the system for one channel. */
export interface Transport {
  channel: Channel;
  send(ctx: SendContext, message: OutboundMessage): Promise<{ providerMessageId: string | null }>;
}
