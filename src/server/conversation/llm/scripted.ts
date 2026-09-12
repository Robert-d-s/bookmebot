import type { LlmClient, LlmRequest, LlmResponse, ToolCall, ToolResult, Turn } from "./types";

/**
 * A rule engine wearing the LlmClient interface. It plays the model's part
 * with the same tools and the same transcript, so the whole loop, the
 * guardrails and the channels are exercised with zero spend, deterministically,
 * in CI. It is deliberately narrow: greetings, hours, prices, book, cancel.
 */

const MENU = [
  { id: "menu:book", title: "Book" },
  { id: "menu:hours", title: "Opening hours" },
  { id: "menu:prices", title: "Prices" },
];

type Service = { id: string; name: string; durationMin: number; price: string };

let seq = 0;
const call = (name: string, input: Record<string, unknown> = {}): ToolCall => ({
  id: `scripted-${++seq}`,
  name,
  input,
});
const say = (text: string, quickReplies?: LlmResponse["quickReplies"]): LlmResponse => ({
  text,
  toolCalls: [],
  quickReplies,
  stop: "end",
});
const callTools = (...toolCalls: ToolCall[]): LlmResponse => ({
  text: null,
  toolCalls,
  stop: "tool",
});

export class ScriptedLlm implements LlmClient {
  readonly name = "scripted";

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const last = req.turns.at(-1);
    if (last?.role === "tool") return this.afterTools(req, last.results);
    return this.onUser(req, lastUserText(req.turns));
  }

  private onUser(req: LlmRequest, raw: string): LlmResponse {
    const t = raw.toLowerCase();
    const services = knownServices(req.turns);

    // Button-driven steps (ids come from buttons.ts decodeReply).
    const slot = /slot pick: (\S+) service=(\S+) staff=(\S+)/.exec(raw);
    if (slot) {
      return callTools(
        call("propose_booking", {
          service_id: slot[2],
          start: slot[1],
          ...(slot[3] !== "any" ? { staff_id: slot[3] } : {}),
        }),
      );
    }
    const confirm = /confirm:(\S+)/.exec(raw);
    if (confirm) return callTools(call("confirm_booking", { proposal_id: confirm[1] }));
    const cancel = /cancel:(\S+)/.exec(raw);
    if (cancel) return callTools(call("cancel_booking", { booking_id: cancel[1] }));

    const proposal = pendingProposal(req.turns);
    if (proposal && /^\s*(yes|yep|yeah|ok|okay|sure|da|confirm)\b/.test(t)) {
      return callTools(call("confirm_booking", { proposal_id: proposal }));
    }
    if (proposal && /^\s*(no|nope|nu)\b/.test(t)) {
      return say("No problem. Tell me another day or time and I'll check.", MENU);
    }

    // Continuing a booking: we asked "which day?" and got a day.
    const remembered = services && rememberedService(req.turns, services);
    if (
      remembered &&
      parseDate(t, todayFromContext(req.context)) &&
      !/\b(cancel|anul|hours?|price)/.test(t)
    ) {
      return this.bookingStep(req, raw, services);
    }

    if (/\b(hours?|open|opening|program|orar)\b/.test(t))
      return callTools(call("get_opening_hours"));
    if (/\b(cancel|anul)/.test(t)) return callTools(call("list_my_bookings"));
    if (/\b(prices?|pret|preț|cost|tarif|how much)\b/.test(t))
      return callTools(call("list_services"));

    const wantsBooking =
      /\b(book|appointment|programare|rezerv|service_id=)/.test(t) ||
      (services?.some((s) => t.includes(s.name.toLowerCase())) ?? false);
    if (wantsBooking) {
      if (!services) return callTools(call("list_services"));
      return this.bookingStep(req, raw, services);
    }
    if (/\b(hi|hello|hey|salut|buna|bună)\b/.test(t) || t.trim() === "") {
      return say(
        `Hi${customerName(req.context)}! I can book, reschedule or cancel appointments.`,
        MENU,
      );
    }
    return say("I can help with bookings, opening hours and prices. What would you like?", MENU);
  }

  /** Booking intent with the catalog known: need a service and a day. */
  private bookingStep(req: LlmRequest, raw: string, services: Service[]): LlmResponse {
    const t = raw.toLowerCase();
    const byId = /service_id=(\S+)/.exec(raw)?.[1];
    const service =
      services.find((s) => s.id === byId) ??
      services.find((s) => t.includes(s.name.toLowerCase())) ??
      rememberedService(req.turns, services);
    if (!service) {
      return say(
        "Which service would you like?",
        services.slice(0, 3).map((s) => ({ id: `service:${s.id}`, title: s.name })),
      );
    }
    const date = parseDate(t, todayFromContext(req.context));
    if (!date)
      return say(`${service.name}, great. Which day? (e.g. tomorrow, Tuesday, 2026-09-15)`);
    return callTools(call("get_availability", { service_id: service.id, date }));
  }

  private afterTools(req: LlmRequest, results: ToolResult[]): LlmResponse {
    const r = results[0];
    const out = r.output as Record<string, unknown>;
    if (r.isError) {
      const msg = String(out.error ?? "something went wrong");
      return say(`Sorry, ${msg}. Want to try another time?`, MENU);
    }
    switch (r.name) {
      case "get_opening_hours":
        return say(`Opening hours:\n${(out.lines as string[]).join("\n")}`, MENU);
      case "list_services": {
        // If the catalog was fetched to serve a booking request, continue it.
        const userText = lastUserText(req.turns).toLowerCase();
        const services = out.services as Service[];
        if (
          /\b(book|appointment|programare|rezerv|service_id=)/.test(userText) ||
          services.some((s) => userText.includes(s.name.toLowerCase()))
        ) {
          return this.bookingStep(req, lastUserText(req.turns), services);
        }
        return say("Our services:");
      }
      case "get_availability": {
        const slots = out.slots as { start: string; label: string }[];
        if (slots.length === 0) return say(`Nothing free on ${out.date}. Another day?`);
        return say(`Free times on ${out.date} (${out.total} in total). Pick one:`);
      }
      case "propose_booking":
        return say(
          `Shall I book ${out.service} on ${out.when} with ${out.staff}? Reply yes to confirm.`,
        );
      case "confirm_booking":
        return say(`Booked: ${out.service} on ${out.when} with ${out.staff}. See you then!`, MENU);
      case "list_my_bookings": {
        const bookings = out.bookings as unknown[];
        return say(
          bookings.length
            ? "Your upcoming bookings. Tap one to cancel it:"
            : "You have no upcoming bookings.",
          bookings.length ? undefined : MENU,
        );
      }
      case "cancel_booking":
        return say(`Cancelled your ${out.service} on ${out.when}.`, MENU);
      default:
        return say("Done.", MENU);
    }
  }
}

// --- transcript helpers -------------------------------------------------------

function lastUserText(turns: Turn[]): string {
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i];
    if (t.role === "user") return t.text;
  }
  return "";
}

function lastResult(turns: Turn[], name: string): ToolResult | undefined {
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i];
    if (t.role === "tool") {
      const r = t.results.find((x) => x.name === name && !x.isError);
      if (r) return r;
    }
  }
  return undefined;
}

function knownServices(turns: Turn[]): Service[] | undefined {
  return (lastResult(turns, "list_services")?.output as { services?: Service[] } | undefined)
    ?.services;
}

/** A proposal is pending if the last propose_booking has not been confirmed since. */
function pendingProposal(turns: Turn[]): string | undefined {
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i];
    if (t.role !== "tool") continue;
    if (t.results.some((r) => r.name === "confirm_booking")) return undefined;
    const p = t.results.find((r) => r.name === "propose_booking" && !r.isError);
    if (p) return (p.output as { proposal_id: string }).proposal_id;
  }
  return undefined;
}

function rememberedService(turns: Turn[], services: Service[]): Service | undefined {
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i];
    if (t.role !== "user") continue;
    const low = t.text.toLowerCase();
    const byId = /service_id=(\S+)/.exec(t.text)?.[1];
    const s =
      services.find((x) => x.id === byId) ??
      services.find((x) => low.includes(x.name.toLowerCase()));
    if (s) return s;
  }
  return undefined;
}

function customerName(context: string): string {
  const m = /customer_name=([^\n]+)/.exec(context);
  return m && m[1].trim() !== "-" ? ` ${m[1].trim().split(" ")[0]}` : "";
}

function todayFromContext(context: string): string {
  return /today=(\d{4}-\d{2}-\d{2})/.exec(context)?.[1] ?? new Date().toISOString().slice(0, 10);
}

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/** today / tomorrow / weekday name / YYYY-MM-DD -> YYYY-MM-DD, relative to `today`. */
export function parseDate(text: string, today: string): string | undefined {
  const iso = /\b(\d{4}-\d{2}-\d{2})\b/.exec(text);
  if (iso) return iso[1];
  const [y, m, d] = today.split("-").map(Number);
  const base = new Date(Date.UTC(y, m - 1, d));
  const plus = (n: number) => new Date(base.getTime() + n * 86_400_000).toISOString().slice(0, 10);
  if (/\btoday\b/.test(text)) return plus(0);
  if (/\btomorrow\b/.test(text)) return plus(1);
  const idx = WEEKDAYS.findIndex((w) => new RegExp(`\\b${w}\\b`).test(text));
  if (idx >= 0) {
    const diff = (idx - base.getUTCDay() + 7) % 7 || 7;
    return plus(diff);
  }
  return undefined;
}
