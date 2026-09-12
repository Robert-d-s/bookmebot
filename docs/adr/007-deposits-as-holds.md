# ADR-007: Deposits are holds; Stripe events drive state; a fake gateway keeps it local

Status: accepted
Date: 2026-09-12

## Context

Some services require a deposit at booking time, refunded on cancellation. Money moves
through Stripe (test mode only; no real charges), and Stripe talks back over webhooks
with the same redelivery and ordering caveats as every other provider. The demo must
also work with no Stripe account at all.

## Decision

- **A deposit booking is a PENDING hold.** `createBooking` reserves the slot with
  `status: PENDING` and `holdExpiresAt = now + 30 min`, then creates a Checkout Session
  with the same expiry. The engine already treats PENDING as occupied (ADR-001), so the
  slot cannot be taken while the customer pays, and `releaseExpiredHolds` (cron) frees it
  if they never do. 30 minutes because Stripe's minimum Checkout expiry is 30 minutes.
- **State changes come from Stripe events**, processed by the phase 2 layer:
  `checkout.session.completed` marks PAID and flips PENDING to CONFIRMED;
  `checkout.session.expired` marks EXPIRED and cancels the hold; `charge.refunded`
  marks REFUNDED. Every transition is idempotent and guarded by the current status, so
  redelivery and the sweeper cannot double-apply anything. Metadata carries the booking
  id on both the session and the payment intent, and it is the correlation key, so a
  refund arriving before we know the payment is deferred (ADR-003), not lost.
- **Refund on cancel is initiated by us, confirmed by Stripe.** `cancelBookingAndRefund`
  cancels through the engine, then asks the gateway for a refund. Card refunds usually
  come back `succeeded` synchronously and are marked REFUNDED at once; otherwise the
  payment sits in REFUND_PENDING and the cron sweeper retries. An unpaid hold that is
  cancelled just expires its checkout.
- **Late payment after the hold lapsed is refunded automatically**: the webhook finds the
  booking already CANCELLED and refunds instead of confirming.
- **A `PaymentGateway` interface with three modes.** `stripe` with real test keys;
  `fake` when only a webhook secret is set, where checkout links point at this app's
  `/pay/<session>` page whose button posts a signed `checkout.session.completed` to our
  own webhook; `off` when nothing is set, in which case deposits are skipped. Tests and
  the local demo run in `fake` mode and exercise the whole path except Stripe itself.
- **The owner booking in person collects no deposit** (`collectDeposit: false` from the
  dashboard). Chat, API and simulator bookings do.

## Consequences

- The engine stays payment-agnostic; `bookings/index.ts` is the only place that knows a
  deposit exists, and every customer-facing create/cancel goes through it.
- The refund policy is "always full refund". A cut-off (e.g. no refund inside 24 hours)
  is one condition in `refundDeposit`, deliberately not implemented for the demo.
- Stripe's signature scheme (`t=,v1=` over `${t}.${body}`, 5-minute tolerance) is its own
  helper next to the HMAC one; the two look alike but differ in the signed payload.
- Real Stripe needs `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` and a public `APP_URL`
  for the return pages; locally `stripe listen --forward-to localhost:3000/api/webhooks/stripe`
  provides the webhook secret.
