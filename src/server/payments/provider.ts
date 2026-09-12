import { env } from "@/env";
import { verifyStripeHeader } from "@/server/webhooks/signature";
import type { EventHandler, WebhookProvider } from "@/server/webhooks/types";
import { markCheckoutExpired, markPaid, markRefunded } from "./index";

/**
 * Stripe as a webhook provider. One event per POST; event id is the dedupe
 * key; the booking id (from metadata) is the correlation key so a refund
 * that lands before its checkout is deferred, not lost.
 */
interface StripeEvent {
  id: string;
  type: string;
  data: { object: Record<string, unknown> & { metadata?: Record<string, string> } };
}

export const stripeProvider: WebhookProvider = {
  name: "stripe",
  verify: (rawBody, headers) =>
    env.STRIPE_WEBHOOK_SECRET
      ? verifyStripeHeader(env.STRIPE_WEBHOOK_SECRET, rawBody, headers.get("stripe-signature"))
      : false,
  parse: (rawBody) => {
    const e = JSON.parse(rawBody) as StripeEvent;
    if (!e?.id || !e.type || !e.data?.object) throw new Error("not a Stripe event");
    const o = e.data.object;
    const correlationKey =
      o.metadata?.bookingId ??
      (typeof o.payment_intent === "string" ? o.payment_intent : undefined);
    return [{ providerEventId: e.id, eventType: e.type, correlationKey, payload: o }];
  },
};

export const stripeHandler: EventHandler = async (event) => {
  const o = event.payload as StripeEvent["data"]["object"];
  const str = (k: string) => (typeof o[k] === "string" ? (o[k] as string) : null);
  switch (event.eventType) {
    case "checkout.session.completed": {
      if (o.payment_status && o.payment_status !== "paid") {
        return { kind: "skipped", reason: `payment_status ${String(o.payment_status)}` };
      }
      const r = await markPaid({
        checkoutSessionId: str("id") ?? "",
        paymentIntentId: str("payment_intent"),
      });
      if (!r) return { kind: "defer", reason: `no payment for session ${str("id")}` };
      return {
        kind: "processed",
        result: { bookingId: r.booking.id, bookingStatus: r.booking.status, already: r.already },
      };
    }
    case "checkout.session.expired": {
      const r = await markCheckoutExpired(str("id") ?? "");
      if (!r) return { kind: "skipped", reason: `no payment for session ${str("id")}` };
      return { kind: "processed", result: { changed: r.changed } };
    }
    case "charge.refunded": {
      const pi = str("payment_intent");
      if (!pi) return { kind: "reject", reason: "charge without payment_intent" };
      const refunds = (o.refunds as { data?: { id: string }[] } | undefined)?.data ?? [];
      const r = await markRefunded({ paymentIntentId: pi, refundId: refunds[0]?.id ?? null });
      if (!r) return { kind: "defer", reason: `no payment for intent ${pi} yet` };
      return { kind: "processed", result: { changed: r.changed } };
    }
    default:
      return { kind: "skipped", reason: `unhandled event type ${event.eventType}` };
  }
};
