/**
 * The conversation layer end to end with the scripted brain on real
 * Postgres: booking through buttons, the confirm-in-a-later-turn guardrail,
 * cancelling, and handoff. Messages travel through handleInboundMessage
 * exactly as they would from a channel.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleInboundMessage } from "@/server/channels/inbound";
import type { InboundMessage } from "@/server/channels/types";
import { ToolError, executeTool } from "@/server/conversation/tools";
import { prisma } from "@/server/db/prisma";
import { addDays, localWeekday, toLocalDate } from "@/server/scheduling/time";
import { TZ, createFixture } from "../helpers/fixture";

let f: Awaited<ReturnType<typeof createFixture>>;
let day: string;
const phone = "+40799000900";
let n = 0;

beforeAll(async () => {
  f = await createFixture("conversation");
  day = addDays(toLocalDate(new Date(), TZ), 3);
  while (localWeekday(day as `${number}-${number}-${number}`, TZ) === 0)
    day = addDays(day as `${number}-${number}-${number}`, 1);
});
afterAll(async () => {
  await f.cleanup();
  await prisma.$disconnect();
});

const send = (message: Partial<InboundMessage> & { text?: string }) =>
  handleInboundMessage({
    businessId: f.businessId,
    channel: "SIMULATOR",
    phone,
    name: "Conv Tester",
    message: { kind: "text", text: "", providerMessageId: `conv-${Date.now()}-${++n}`, ...message },
  });
const lastOut = async () =>
  prisma.message.findFirstOrThrow({
    where: { businessId: f.businessId, customer: { phone }, direction: "OUT" },
    orderBy: { createdAt: "desc" },
  });
type Opt = { id: string; title: string };

describe("booking by chat (scripted brain)", () => {
  let slotId: string;
  let confirmId: string;

  it("greets with the menu", async () => {
    await send({ text: "hi" });
    const m = await lastOut();
    expect(m.kind).toBe("buttons");
    expect(m.text).toContain("Conv");
    expect((m.payload as { buttons: Opt[] }).buttons.map((b) => b.id)).toEqual([
      "menu:book",
      "menu:hours",
      "menu:prices",
    ]);
  });

  it("asks for the day, then offers times as a list", async () => {
    await send({ text: "I want to book a Cut" });
    expect((await lastOut()).text).toMatch(/Which day/);
    await send({ text: `${day} please` });
    const m = await lastOut();
    expect(m.kind).toBe("list");
    const rows = (m.payload as { rows: Opt[] }).rows;
    expect(rows.length).toBeGreaterThan(3);
    expect(rows[0].id).toMatch(/^slot:/);
    slotId = rows[0].id;
  });

  it("proposes the tapped slot and asks for confirmation", async () => {
    await send({ kind: "list_reply", replyId: slotId, text: "10:00" });
    const m = await lastOut();
    expect(m.text).toMatch(/Shall I book Cut/);
    const buttons = (m.payload as { buttons: Opt[] }).buttons;
    expect(buttons.map((b) => b.id)).toEqual([expect.stringMatching(/^confirm:/), "decline"]);
    confirmId = buttons[0].id;
    expect(
      await prisma.booking.count({ where: { businessId: f.businessId, customer: { phone } } }),
    ).toBe(0);
  });

  it("books only after the customer confirms in the next message", async () => {
    await send({ kind: "button_reply", replyId: confirmId, text: "Yes, book it" });
    expect((await lastOut()).text).toMatch(/^Booked: Cut/);
    const booking = await prisma.booking.findFirstOrThrow({
      where: { businessId: f.businessId, customer: { phone } },
    });
    expect(booking.status).toBe("CONFIRMED");
    expect(booking.source).toBe("SIMULATOR");
    expect(booking.startsAt.toISOString()).toBe(slotId.split(":").slice(1).join(":").split("|")[0]);
  });

  it("lists bookings on 'cancel' and cancels the tapped one", async () => {
    await send({ text: "I need to cancel" });
    const m = await lastOut();
    expect(m.kind).toBe("list");
    const row = (m.payload as { rows: Opt[] }).rows[0];
    expect(row.id).toMatch(/^cancel:/);
    await send({ kind: "list_reply", replyId: row.id, text: row.title });
    expect((await lastOut()).text).toMatch(/^Cancelled/);
    const booking = await prisma.booking.findFirstOrThrow({
      where: { businessId: f.businessId, customer: { phone } },
    });
    expect(booking.status).toBe("CANCELLED");
  });

  it("goes silent after handoff", async () => {
    const customer = await prisma.customer.findUniqueOrThrow({
      where: { businessId_phone: { businessId: f.businessId, phone } },
    });
    await prisma.conversation.update({
      where: { customerId: customer.id },
      data: { mode: "HUMAN" },
    });
    const before = await prisma.message.count({
      where: { customerId: customer.id, direction: "OUT" },
    });
    const r = await send({ text: "hello?" });
    expect(r.replies).toBe(0);
    expect(
      await prisma.message.count({ where: { customerId: customer.id, direction: "OUT" } }),
    ).toBe(before);
    await prisma.conversation.update({ where: { customerId: customer.id }, data: { mode: "BOT" } });
  });
});

describe("guardrails in the tools themselves", () => {
  it("confirm_booking refuses a proposal from the same customer turn, an unknown one, and an expired one", async () => {
    const customer = await prisma.customer.findUniqueOrThrow({
      where: { businessId_phone: { businessId: f.businessId, phone } },
    });
    const now = new Date();
    const ctx = {
      businessId: f.businessId,
      customer: { id: customer.id, name: customer.name },
      channel: "SIMULATOR" as const,
      timezone: TZ,
      state: { turn: 5 },
      now,
    };
    const avail = (await executeTool(
      "get_availability",
      { service_id: f.service.id, date: day },
      ctx,
    )) as { slots: { start: string }[] };
    const start = avail.slots[avail.slots.length - 1].start;
    const proposal = (await executeTool(
      "propose_booking",
      { service_id: f.service.id, start },
      ctx,
    )) as { proposal_id: string };

    await expect(
      executeTool("confirm_booking", { proposal_id: proposal.proposal_id }, ctx),
    ).rejects.toThrow(/not answered/);
    await expect(
      executeTool(
        "confirm_booking",
        { proposal_id: "nope" },
        { ...ctx, state: { ...ctx.state, turn: 6 } },
      ),
    ).rejects.toThrow(/no such proposal/);
    await expect(
      executeTool(
        "confirm_booking",
        { proposal_id: proposal.proposal_id },
        { ...ctx, state: { ...ctx.state, turn: 6 }, now: new Date(now.getTime() + 60 * 60_000) },
      ),
    ).rejects.toBeInstanceOf(ToolError);

    // Next turn, within the TTL: allowed, and the engine makes the booking.
    const booked = (await executeTool(
      "confirm_booking",
      { proposal_id: proposal.proposal_id },
      { ...ctx, state: { ...ctx.state, turn: 6 } },
    )) as { status: string };
    expect(booked.status).toBe("CONFIRMED");
  });

  it("a proposal for a taken time is refused by the engine, not by the prompt", async () => {
    const customer = await prisma.customer.findUniqueOrThrow({
      where: { businessId_phone: { businessId: f.businessId, phone } },
    });
    const ctx = {
      businessId: f.businessId,
      customer: { id: customer.id, name: customer.name },
      channel: "SIMULATOR" as const,
      timezone: TZ,
      state: { turn: 1 },
      now: new Date(),
    };
    await expect(
      executeTool(
        "propose_booking",
        { service_id: f.service.id, start: `${day}T03:00:00.000Z` },
        ctx,
      ),
    ).rejects.toThrow(/not available/);
  });

  it("cannot touch another customer's booking", async () => {
    const other = await prisma.customer.create({
      data: { businessId: f.businessId, phone: "+40799000901" },
    });
    const mine = await prisma.booking.findFirstOrThrow({
      where: { businessId: f.businessId, customer: { phone }, status: "CONFIRMED" },
    });
    const ctx = {
      businessId: f.businessId,
      customer: { id: other.id, name: null },
      channel: "SIMULATOR" as const,
      timezone: TZ,
      state: { turn: 1 },
      now: new Date(),
    };
    await expect(executeTool("cancel_booking", { booking_id: mine.id }, ctx)).rejects.toThrow(
      /no such booking/,
    );
  });
});
