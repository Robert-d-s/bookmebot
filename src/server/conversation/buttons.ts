import type { OutboundMessage } from "@/server/channels/types";
import type { QuickReply, ToolResult } from "./llm/types";

/**
 * Buttons are the API between the chat UI and the model. Ids are stable and
 * machine-readable; titles are for humans. An inbound tap is turned into a
 * sentence the model (or the rule engine) understands.
 */

export function decodeReply(replyId: string, title: string): string {
  const [kind, rest] = splitOnce(replyId, ":");
  switch (kind) {
    case "slot": {
      const [start, serviceId, staffId] = rest.split("|");
      return `slot pick: ${start} service=${serviceId} staff=${staffId ?? "any"} (${title})`;
    }
    case "confirm":
      return `confirm:${rest} yes, please book it`;
    case "decline":
      return "no, not that time";
    case "cancel":
      return `cancel:${rest} please cancel this booking (${title})`;
    case "service":
      return `I'd like ${title} (service_id=${rest})`;
    case "menu":
      return (
        {
          book: "I'd like to book an appointment",
          hours: "What are your opening hours?",
          prices: "What services and prices do you have?",
        }[rest] ?? title
      );
    default:
      return title;
  }
}

const shortLabel = (label: string) =>
  label.replace(/^(\w{3}) (\d+) (\w{3}),? /, "$1 $2 $3 ").slice(0, 20);

/** Buttons implied by this turn's tool results. Later results win. */
export function buttonsFromResults(results: ToolResult[]): {
  buttons?: QuickReply[];
  rows?: QuickReply[];
  button?: string;
} {
  for (const r of [...results].reverse()) {
    if (r.isError) continue;
    const out = r.output as Record<string, unknown>;
    switch (r.name) {
      case "get_availability": {
        const slots =
          (out.slots as {
            start: string;
            label: string;
            staff_ids: string[];
            service_id: string;
          }[]) ?? [];
        const staff = (s: { staff_ids: string[] }) =>
          s.staff_ids.length === 1 ? s.staff_ids[0] : "any";
        if (slots.length <= 3)
          return {
            buttons: slots.map((s) => ({
              id: `slot:${s.start}|${s.service_id}|${staff(s)}`,
              title: shortLabel(s.label),
            })),
          };
        return {
          button: "Pick a time",
          rows: slots.map((s) => ({
            id: `slot:${s.start}|${s.service_id}|${staff(s)}`,
            title: shortLabel(s.label),
          })),
        };
      }
      case "propose_booking":
        return {
          buttons: [
            { id: `confirm:${out.proposal_id}`, title: "Yes, book it" },
            { id: "decline", title: "No" },
          ],
        };
      case "list_my_bookings": {
        const bookings =
          (out.bookings as { booking_id: string; service: string; when: string }[]) ?? [];
        if (!bookings.length) return {};
        return {
          button: "My bookings",
          rows: bookings.map((b) => ({
            id: `cancel:${b.booking_id}`,
            title: shortLabel(b.when),
            description: b.service,
          })),
        };
      }
      case "list_services": {
        const services =
          (out.services as { id: string; name: string; durationMin: number; price: string }[]) ??
          [];
        return {
          button: "Services",
          rows: services.map((s) => ({
            id: `service:${s.id}`,
            title: s.name.slice(0, 24),
            description: `${s.durationMin} min · ${s.price}`,
          })),
        };
      }
    }
  }
  return {};
}

/** One outbound message: buttons or a list when there are options, plain text otherwise. */
export function compose(
  text: string | null,
  opts: {
    buttons?: QuickReply[];
    rows?: (QuickReply & { description?: string })[];
    button?: string;
  },
): OutboundMessage[] {
  const body = text?.trim() || "Choose an option:";
  if (opts.rows?.length)
    return [{ kind: "list", text: body, button: opts.button ?? "Options", rows: opts.rows }];
  if (opts.buttons?.length)
    return [{ kind: "buttons", text: body, buttons: opts.buttons.slice(0, 3) }];
  return text ? [{ kind: "text", text }] : [];
}

function splitOnce(s: string, sep: string): [string, string] {
  const i = s.indexOf(sep);
  return i < 0 ? [s, ""] : [s.slice(0, i), s.slice(i + 1)];
}
