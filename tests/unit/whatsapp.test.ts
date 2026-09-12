import { describe, expect, it } from "vitest";
import { sendWhatsApp, toGraphPayload } from "@/server/channels/whatsapp/api";
import { normaliseMessage, parseWhatsAppWebhook, toE164 } from "@/server/channels/whatsapp/parse";
import { whatsappProvider } from "@/server/channels/whatsapp/provider";
import { hmacSha256Hex } from "@/server/webhooks/signature";

/** A real-shaped Cloud API delivery: one text, one button reply, one status. */
const delivery = {
  object: "whatsapp_business_account",
  entry: [
    {
      id: "WABA",
      changes: [
        {
          field: "messages",
          value: {
            messaging_product: "whatsapp",
            metadata: { display_phone_number: "15550001111", phone_number_id: "PNID1" },
            contacts: [{ profile: { name: "Ana Pop" }, wa_id: "40721000001" }],
            messages: [
              {
                from: "40721000001",
                id: "wamid.1",
                timestamp: "1",
                type: "text",
                text: { body: "hi" },
              },
              {
                from: "40721000001",
                id: "wamid.2",
                timestamp: "2",
                type: "interactive",
                interactive: {
                  type: "button_reply",
                  button_reply: { id: "menu:hours", title: "Opening hours" },
                },
              },
              {
                from: "40721000001",
                id: "wamid.3",
                timestamp: "3",
                type: "image",
                image: { id: "x" },
              },
            ],
            statuses: [
              { id: "wamid.out", status: "delivered", timestamp: "4", recipient_id: "40721000001" },
            ],
          },
        },
      ],
    },
  ],
};

describe("parseWhatsAppWebhook", () => {
  it("yields one event per message and per status, with names and E.164 phones", () => {
    const events = parseWhatsAppWebhook(JSON.stringify(delivery));
    expect(events.map((e) => [e.providerEventId, e.eventType])).toEqual([
      ["wamid.1", "message"],
      ["wamid.2", "message"],
      ["wamid.3", "message"],
      ["wamid.out:delivered", "status"],
    ]);
    const first = events[0].payload as {
      from: string;
      name?: string;
      message: { kind: string; text: string | null };
    };
    expect(first.from).toBe("+40721000001");
    expect(first.name).toBe("Ana Pop");
    expect(first.message).toMatchObject({ kind: "text", text: "hi" });
    expect((events[1].payload as { message: { replyId?: string } }).message.replyId).toBe(
      "menu:hours",
    );
    expect((events[2].payload as { message: { kind: string } }).message.kind).toBe("unsupported");
    expect(events[0].correlationKey).toBe("+40721000001");
  });

  it("rejects a body that is not a WhatsApp webhook", () => {
    expect(() => parseWhatsAppWebhook('{"object":"page"}')).toThrow();
  });

  it("helpers", () => {
    expect(toE164("40721")).toBe("+40721");
    expect(toE164("+40721")).toBe("+40721");
    expect(
      normaliseMessage({
        id: "m",
        from: "1",
        timestamp: "0",
        type: "interactive",
        interactive: { type: "list_reply", list_reply: { id: "service:x", title: "Haircut" } },
      }),
    ).toMatchObject({ kind: "list_reply", replyId: "service:x", text: "Haircut" });
  });
});

describe("whatsappProvider", () => {
  const secret = process.env.WHATSAPP_APP_SECRET;
  it("verifies X-Hub-Signature-256 when the app secret is configured, refuses when not", () => {
    const raw = JSON.stringify(delivery);
    if (secret) {
      const ok = new Headers({ "x-hub-signature-256": `sha256=${hmacSha256Hex(secret, raw)}` });
      expect(whatsappProvider.verify(raw, ok)).toBe(true);
      expect(whatsappProvider.verify(raw + " ", ok)).toBe(false);
    } else {
      expect(
        whatsappProvider.verify(raw, new Headers({ "x-hub-signature-256": "sha256=abc" })),
      ).toBe(false);
    }
  });

  it("answers the GET challenge only with the right verify token", async () => {
    const token = process.env.WHATSAPP_VERIFY_TOKEN;
    const url = (t: string) =>
      new URL(
        `http://x/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${t}&hub.challenge=12345`,
      );
    const bad = whatsappProvider.challenge!(url("wrong"));
    expect(bad?.status).toBe(403);
    if (token) {
      const good = whatsappProvider.challenge!(url(token));
      expect(good?.status).toBe(200);
      expect(await good?.text()).toBe("12345");
    }
    expect(whatsappProvider.challenge!(new URL("http://x/api/webhooks/whatsapp"))).toBeNull();
  });
});

describe("Graph API payloads", () => {
  it("text, buttons and lists follow the Cloud API shapes and limits", () => {
    expect(toGraphPayload("+40721000001", { kind: "text", text: "hello" })).toMatchObject({
      messaging_product: "whatsapp",
      to: "40721000001",
      type: "text",
      text: { body: "hello" },
    });
    const buttons = toGraphPayload("+1", {
      kind: "buttons",
      text: "?",
      buttons: [1, 2, 3, 4].map((i) => ({ id: `b${i}`, title: `A very long button title ${i}` })),
    }) as { interactive: { action: { buttons: { reply: { title: string } }[] } } };
    expect(buttons.interactive.action.buttons).toHaveLength(3);
    expect(buttons.interactive.action.buttons[0].reply.title.length).toBeLessThanOrEqual(20);
    const list = toGraphPayload("+1", {
      kind: "list",
      text: "?",
      button: "Pick",
      rows: [{ id: "r1", title: "Row", description: "d" }],
    }) as { interactive: { type: string; action: { sections: { rows: unknown[] }[] } } };
    expect(list.interactive.type).toBe("list");
    expect(list.interactive.action.sections[0].rows).toHaveLength(1);
  });

  it("sendWhatsApp posts to the phone number's messages endpoint with the bearer token", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ messages: [{ id: "wamid.sent" }] }), { status: 200 });
    }) as typeof fetch;
    const r = await sendWhatsApp(
      "PNID1",
      "+40721000001",
      { kind: "text", text: "yo" },
      {
        fetch: fakeFetch,
        accessToken: "TOKEN",
        version: "v22.0",
      },
    );
    expect(r.providerMessageId).toBe("wamid.sent");
    expect(calls[0].url).toBe("https://graph.facebook.com/v22.0/PNID1/messages");
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe("Bearer TOKEN");
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({ to: "40721000001" });
  });

  it("surfaces API errors with status and body", async () => {
    const fakeFetch = (async () =>
      new Response('{"error":"nope"}', { status: 401 })) as typeof fetch;
    await expect(
      sendWhatsApp("P", "+1", { kind: "text", text: "x" }, { fetch: fakeFetch, accessToken: "T" }),
    ).rejects.toMatchObject({ status: 401 });
  });
});
