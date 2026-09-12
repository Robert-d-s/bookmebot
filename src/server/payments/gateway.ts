import { randomUUID } from "node:crypto";
import Stripe from "stripe";
import { env } from "@/env";

/**
 * The slice of Stripe we use, behind an interface so tests and the local
 * demo run without an account.
 *
 * Modes (derived from env):
 *   stripe  STRIPE_SECRET_KEY set: real test-mode Checkout and refunds
 *   fake    only STRIPE_WEBHOOK_SECRET set: checkout links point at /pay/<id>
 *           in this app, which posts a signed checkout.session.completed
 *           event to our own webhook, so the whole path is exercised
 *   off     neither: deposits are skipped, bookings confirm directly
 */
export interface CheckoutArgs {
  amountCents: number;
  currency: string;
  description: string;
  bookingId: string;
  businessId: string;
  expiresAt: Date;
  successUrl: string;
  cancelUrl: string;
}

export interface PaymentGateway {
  readonly mode: "stripe" | "fake";
  createCheckout(args: CheckoutArgs): Promise<{ id: string; url: string }>;
  expireCheckout(id: string): Promise<void>;
  createRefund(
    paymentIntentId: string,
  ): Promise<{ id: string; status: "succeeded" | "pending" | "failed" }>;
}

export class StripeGateway implements PaymentGateway {
  readonly mode = "stripe" as const;
  constructor(private readonly stripe: Stripe) {}

  async createCheckout(a: CheckoutArgs) {
    const session = await this.stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: a.currency.toLowerCase(),
            unit_amount: a.amountCents,
            product_data: { name: a.description },
          },
        },
      ],
      // Stripe requires at least 30 minutes; the booking hold matches.
      expires_at: Math.floor(a.expiresAt.getTime() / 1000),
      success_url: a.successUrl,
      cancel_url: a.cancelUrl,
      metadata: { bookingId: a.bookingId, businessId: a.businessId },
      payment_intent_data: { metadata: { bookingId: a.bookingId, businessId: a.businessId } },
    });
    if (!session.url) throw new Error("Stripe returned a session without a url");
    return { id: session.id, url: session.url };
  }

  async expireCheckout(id: string) {
    await this.stripe.checkout.sessions.expire(id);
  }

  async createRefund(paymentIntentId: string) {
    const refund = await this.stripe.refunds.create({ payment_intent: paymentIntentId });
    const status =
      refund.status === "succeeded"
        ? "succeeded"
        : refund.status === "failed"
          ? "failed"
          : "pending";
    return { id: refund.id, status: status as "succeeded" | "pending" | "failed" };
  }
}

export class FakeGateway implements PaymentGateway {
  readonly mode = "fake" as const;
  readonly refunds: string[] = [];

  async createCheckout(a: CheckoutArgs) {
    const id = `cs_fake_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
    return { id, url: `${env.APP_URL}/pay/${id}?booking=${a.bookingId}` };
  }
  async expireCheckout() {}
  async createRefund(paymentIntentId: string) {
    this.refunds.push(paymentIntentId);
    return { id: `re_fake_${randomUUID().slice(0, 8)}`, status: "succeeded" as const };
  }
}

let override: PaymentGateway | null | undefined;
let cached: PaymentGateway | null | undefined;

export function getGateway(): PaymentGateway | null {
  if (override !== undefined) return override;
  if (cached !== undefined) return cached;
  if (env.STRIPE_SECRET_KEY) cached = new StripeGateway(new Stripe(env.STRIPE_SECRET_KEY));
  else if (env.STRIPE_WEBHOOK_SECRET) cached = new FakeGateway();
  else cached = null;
  return cached;
}

/** Tests inject a gateway; `undefined` restores env-driven selection. */
export function setGateway(g: PaymentGateway | null | undefined) {
  override = g;
}

export const paymentsEnabled = () => getGateway() !== null;
