/**
 * Inbound messages end to end on real Postgres: simulator provider and
 * WhatsApp provider both land in the shared pipeline, create the customer
 * on first contact, log IN and OUT messages, and dedupe redeliveries.
 * WhatsApp sends are captured by a test transport, so no network.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { env } from "@/env";
import { handleInboundMessage } from "@/server/channels/inbound";
import { setTransport, whatsappTransport } from "@/server/channels/transports";
import type { OutboundMessage } from "@/server/channels/types";
import { prisma } from "@/server/db/prisma";
import { hmacSha256Hex, ingest, processEvent } from "@/server/webhooks";
import { createFixture } from "../helpers/fixture";

let f: Awaited<ReturnType<typeof createFixture>>;
let slug: string;
const sentToWhatsApp: OutboundMessage[] = [];

beforeAll(async () => {
  f = await createFixture("channels");
  const b = await prisma.business.update({
    where: { id: f.businessId },
    data: { whatsappPhoneNumberId: `PN-${Date.now()}` },
  });
  slug = b.slug;
  setTransport({
    channel: "WHATSAPP",
    send: async (_ctx, m) => {
      sentToWhatsApp.push(m);
      return { providerMessageId: `wamid.out.${sentToWhatsApp.length}` };
    },
  });
});
afterAll(async () => {
  setTransport(whatsappTransport);
  await prisma.webhookDelivery.deleteMany({
    where: { provider: { in: ["simulator", "whatsapp"] } },
  });
  await f.cleanup();
  await prisma.$disconnect();
});

const signed = (provider: string, secret: string, body: object, header: string) => {
  const raw = JSON.stringify(body);
  return ingest(provider, raw, new Headers({ [header]: `sha256=${hmacSha256Hex(secret, raw)}` }));
};
const drain = async (r: Awaited<ReturnType<typeof ingest>>) => {
  if (r.status !== 200) throw new Error(`ingest ${r.status}`);
  for (const id of r.newEventIds) await processEvent(id);
};
const thread = (phone: string) =>
  prisma.message.findMany({
    where: { businessId: f.businessId, customer: { phone } },
    orderBy: { createdAt: "asc" },
  });

describe("simulator channel", () => {
  const phone = "+40799000123";

  it("first contact creates the customer, logs IN, answers with greeting + menu", async () => {
    await drain(
      await signed(
        "simulator",
        env.WEBHOOK_SIMULATOR_SECRET,
        {
          events: [
            {
              id: `s1-${phone}`,
              type: "message.received",
              data: { business: slug, from: phone, name: "Sim One", text: "hi" },
            },
          ],
        },
        "x-signature",
      ),
    );
    const customer = await prisma.customer.findUniqueOrThrow({
      where: { businessId_phone: { businessId: f.businessId, phone } },
    });
    expect(customer.name).toBe("Sim One");
    const msgs = await thread(phone);
    expect(msgs.map((m) => [m.direction, m.kind])).toEqual([
      ["IN", "text"],
      ["OUT", "text"],
      ["OUT", "buttons"],
    ]);
    expect(msgs[1].text).toContain("Sim");
    expect((msgs[2].payload as { buttons: unknown[] }).buttons).toHaveLength(3);
  });

  it("a button reply is understood and answered with real opening hours", async () => {
    await drain(
      await signed(
        "simulator",
        env.WEBHOOK_SIMULATOR_SECRET,
        {
          events: [
            {
              id: `s2-${phone}`,
              type: "message.received",
              data: {
                business: slug,
                from: phone,
                reply: { id: "menu:hours", title: "Opening hours" },
              },
            },
          ],
        },
        "x-signature",
      ),
    );
    const msgs = await thread(phone);
    const hours = msgs.filter((m) => m.direction === "OUT").at(-2);
    expect(hours?.text).toContain("Mon: 09:00–18:00");
    expect(hours?.text).toContain("Sun: closed");
  });

  it("redelivery of the same event does not double the thread", async () => {
    const before = (await thread(phone)).length;
    await drain(
      await signed(
        "simulator",
        env.WEBHOOK_SIMULATOR_SECRET,
        {
          events: [
            {
              id: `s1-${phone}`,
              type: "message.received",
              data: { business: slug, from: phone, text: "hi" },
            },
          ],
        },
        "x-signature",
      ),
    );
    expect((await thread(phone)).length).toBe(before);
  });
});

describe("whatsapp channel", () => {
  const secret = env.WHATSAPP_APP_SECRET;
  const wa = (phoneNumberId: string, messages: object[]) => ({
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "1", phone_number_id: phoneNumberId },
              contacts: [{ profile: { name: "Wa Customer" }, wa_id: "40799000456" }],
              messages,
            },
          },
        ],
      },
    ],
  });

  it.skipIf(!secret)(
    "routes by phone_number_id, sends replies through the transport, logs wamids",
    async () => {
      const pn = (await prisma.business.findUniqueOrThrow({ where: { id: f.businessId } }))
        .whatsappPhoneNumberId!;
      await drain(
        await signed(
          "whatsapp",
          secret!,
          wa(pn, [
            {
              from: "40799000456",
              id: `wamid.${Date.now()}`,
              timestamp: "1",
              type: "text",
              text: { body: "prices?" },
            },
          ]),
          "x-hub-signature-256",
        ),
      );
      const msgs = await thread("+40799000456");
      expect(msgs.map((m) => m.direction)).toEqual(["IN", "OUT"]);
      expect(msgs[1].kind).toBe("list");
      expect(msgs[1].providerMessageId).toMatch(/^wamid\.out\./);
      expect(sentToWhatsApp.at(-1)?.kind).toBe("list");
    },
  );

  it.skipIf(!secret)("an unknown phone_number_id is rejected to the dead letter", async () => {
    const r = await signed(
      "whatsapp",
      secret!,
      wa("PN-unknown", [
        {
          from: "40799000456",
          id: `wamid.x${Date.now()}`,
          timestamp: "1",
          type: "text",
          text: { body: "hi" },
        },
      ]),
      "x-hub-signature-256",
    );
    if (r.status !== 200) throw new Error("ingest failed");
    expect(await processEvent(r.newEventIds[0])).toMatchObject({ kind: "reject" });
  });

  it("refuses unsigned traffic", async () => {
    const r = await ingest("whatsapp", JSON.stringify(wa("x", [])), new Headers());
    expect(r.status).toBe(401);
  });
});

describe("handleInboundMessage directly", () => {
  it("is idempotent on provider message id", async () => {
    const args = {
      businessId: f.businessId,
      channel: "SIMULATOR" as const,
      phone: "+40799000789",
      message: { kind: "text" as const, text: "hello", providerMessageId: `direct-${Date.now()}` },
    };
    const first = await handleInboundMessage(args);
    const second = await handleInboundMessage(args);
    expect(first.duplicate).toBe(false);
    expect(first.replies).toBe(2);
    expect(second.duplicate).toBe(true);
  });
});
