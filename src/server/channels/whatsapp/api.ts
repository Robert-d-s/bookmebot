import { env } from "@/env";
import type { OutboundMessage } from "../types";

/**
 * Outbound side of the Cloud API: POST /{phone_number_id}/messages.
 * `fetch` and the token are injectable so tests never touch the network.
 */

export interface GraphDeps {
  fetch?: typeof fetch;
  accessToken?: string;
  version?: string;
}

export function toGraphPayload(to: string, message: OutboundMessage): Record<string, unknown> {
  const base = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: to.replace(/^\+/, ""),
  };
  switch (message.kind) {
    case "text":
      return { ...base, type: "text", text: { preview_url: false, body: message.text } };
    case "buttons":
      return {
        ...base,
        type: "interactive",
        interactive: {
          type: "button",
          body: { text: message.text },
          action: {
            buttons: message.buttons.slice(0, 3).map((b) => ({
              type: "reply",
              reply: { id: b.id, title: b.title.slice(0, 20) },
            })),
          },
        },
      };
    case "list":
      return {
        ...base,
        type: "interactive",
        interactive: {
          type: "list",
          body: { text: message.text },
          action: {
            button: message.button.slice(0, 20),
            sections: [
              {
                title: "Options",
                rows: message.rows.slice(0, 10).map((r) => ({
                  id: r.id,
                  title: r.title.slice(0, 24),
                  ...(r.description ? { description: r.description.slice(0, 72) } : {}),
                })),
              },
            ],
          },
        },
      };
  }
}

export class WhatsAppApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`WhatsApp API ${status}: ${body.slice(0, 200)}`);
    this.name = "WhatsAppApiError";
  }
}

export async function sendWhatsApp(
  phoneNumberId: string,
  to: string,
  message: OutboundMessage,
  deps: GraphDeps = {},
): Promise<{ providerMessageId: string | null }> {
  const token = deps.accessToken ?? env.WHATSAPP_ACCESS_TOKEN;
  if (!token) throw new Error("WHATSAPP_ACCESS_TOKEN is not configured");
  const version = deps.version ?? env.WHATSAPP_GRAPH_VERSION;
  const doFetch = deps.fetch ?? fetch;

  const res = await doFetch(`https://graph.facebook.com/${version}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(toGraphPayload(to, message)),
  });
  const text = await res.text();
  if (!res.ok) throw new WhatsAppApiError(res.status, text);
  const json = JSON.parse(text) as { messages?: { id: string }[] };
  return { providerMessageId: json.messages?.[0]?.id ?? null };
}
