import type { InboundMessage, OutboundMessage } from "@/server/channels/types";
import { prisma } from "@/server/db/prisma";

/**
 * Conversation layer, phase 4 edition: a scripted responder so the channels
 * can be exercised end to end. Phase 5 replaces the body of `respond` with
 * the LLM + tool loop; the signature stays.
 */
export interface RespondArgs {
  businessId: string;
  customer: { id: string; name: string | null };
  message: InboundMessage;
}

const MENU: OutboundMessage = {
  kind: "buttons",
  text: "What can I do for you?",
  buttons: [
    { id: "menu:book", title: "Book" },
    { id: "menu:hours", title: "Opening hours" },
    { id: "menu:prices", title: "Prices" },
  ],
};

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const hhmm = (m: number) =>
  `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

export async function respond(args: RespondArgs): Promise<OutboundMessage[]> {
  const intent = detectIntent(args.message);
  const business = await prisma.business.findUniqueOrThrow({
    where: { id: args.businessId },
    select: { name: true },
  });

  switch (intent) {
    case "hours": {
      const rules = await prisma.availabilityRule.findMany({
        where: { businessId: args.businessId, staffId: null },
        orderBy: [{ weekday: "asc" }, { startMin: "asc" }],
      });
      const lines = DAYS.map((d, i) => {
        const r = rules.filter((x) => x.weekday === i);
        return `${d}: ${r.length ? r.map((x) => `${hhmm(x.startMin)}–${hhmm(x.endMin)}`).join(", ") : "closed"}`;
      });
      return [{ kind: "text", text: `${business.name} opening hours:\n${lines.join("\n")}` }, MENU];
    }
    case "prices": {
      const services = await prisma.service.findMany({
        where: { businessId: args.businessId, active: true },
        orderBy: { name: "asc" },
      });
      return [
        {
          kind: "list",
          text: "Our services:",
          button: "See services",
          rows: services.slice(0, 10).map((s) => ({
            id: `service:${s.id}`,
            title: s.name,
            description: `${s.durationMin} min · ${(s.priceCents / 100).toFixed(0)} ${s.currency}`,
          })),
        },
      ];
    }
    case "book":
      return [
        {
          kind: "text",
          text: "Booking by chat arrives in the next phase. For now the salon can book you in from the dashboard, or ask me for hours and prices.",
        },
        MENU,
      ];
    case "service": {
      return [
        {
          kind: "text",
          text: `Good choice. Booking ${args.message.text} by chat arrives in the next phase.`,
        },
        MENU,
      ];
    }
    case "greeting":
    default: {
      const hello = args.customer.name ? `Hi ${args.customer.name.split(" ")[0]}!` : "Hi!";
      return [{ kind: "text", text: `${hello} This is the ${business.name} assistant.` }, MENU];
    }
  }
}

type Intent = "greeting" | "hours" | "prices" | "book" | "service" | "unknown";

export function detectIntent(m: InboundMessage): Intent {
  if (m.kind === "button_reply" || m.kind === "list_reply") {
    const id = m.replyId ?? "";
    if (id === "menu:hours") return "hours";
    if (id === "menu:prices") return "prices";
    if (id === "menu:book") return "book";
    if (id.startsWith("service:")) return "service";
    return "unknown";
  }
  const t = (m.text ?? "").toLowerCase();
  if (/\b(hours?|open|opening|program|orar|când|cand)\b/.test(t)) return "hours";
  if (/\b(price|pret|preț|cost|tarif|service|how much)/.test(t)) return "prices";
  if (/\b(book|appointment|programare|rezerv)/.test(t)) return "book";
  if (/\b(hi|hello|hey|salut|buna|bună)\b/.test(t)) return "greeting";
  return "unknown";
}
