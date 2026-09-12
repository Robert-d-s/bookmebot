"use server";

import { redirect } from "next/navigation";
import { env } from "@/env";
import { prisma } from "@/server/db/prisma";
import { getGateway } from "@/server/payments";
import { ingest, processEvent } from "@/server/webhooks";
import { signStripe } from "@/server/webhooks/signature";

/**
 * Fake-gateway "Pay now": builds a Stripe-shaped checkout.session.completed
 * event, signs it with our own webhook secret, and pushes it through the real
 * webhook layer. The only thing skipped is Stripe itself.
 */
export async function simulatePaymentAction(formData: FormData) {
  const sessionId = String(formData.get("sessionId") ?? "");
  if (getGateway()?.mode !== "fake" || !env.STRIPE_WEBHOOK_SECRET)
    redirect(`/pay/${sessionId}?error=not-fake`);
  const payment = await prisma.payment.findUnique({ where: { checkoutSessionId: sessionId } });
  if (!payment) redirect(`/pay/${sessionId}?error=unknown`);

  const event = {
    id: `evt_fake_${sessionId}_completed`,
    type: "checkout.session.completed",
    data: {
      object: {
        id: sessionId,
        object: "checkout.session",
        payment_status: "paid",
        payment_intent: `pi_fake_${sessionId.slice(8)}`,
        amount_total: payment.amountCents,
        currency: payment.currency.toLowerCase(),
        metadata: { bookingId: payment.bookingId, businessId: payment.businessId },
      },
    },
  };
  const raw = JSON.stringify(event);
  const r = await ingest(
    "stripe",
    raw,
    new Headers({ "stripe-signature": signStripe(env.STRIPE_WEBHOOK_SECRET, raw) }),
  );
  if (r.status === 200) for (const id of r.newEventIds) await processEvent(id);
  redirect(`/pay/${sessionId}?paid=1`);
}
