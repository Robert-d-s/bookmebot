# Learning note 06: Deposits and refunds

Stripe test mode through the same webhook layer as everything else, and a fake gateway
so the whole flow runs on the laptop with no account.

## Shape

```
src/server/payments/gateway.ts   PaymentGateway: Stripe (test keys) | Fake (local) | off
src/server/payments/index.ts     createDepositCheckout, markPaid, markCheckoutExpired,
                                 refundDeposit, markRefunded, sweepPayments
src/server/payments/provider.ts  "stripe" webhook provider: signature, parse, handler
src/server/bookings/index.ts     createBooking (deposit-aware), cancelBookingAndRefund
src/app/pay/[sessionId]/         return page; in fake mode, the checkout itself
scripts + cron tick              sweepPayments after releaseExpiredHolds
```

## The life of a deposit

```
customer confirms in chat (or POST /api/bookings)
  createBooking: service.depositCents > 0 and payments on
    reserveSlot PENDING, holdExpiresAt = now + 30 min          slot is occupied
    gateway.createCheckout(amount, expires_at = same)          payment REQUIRES_PAYMENT
    reply: "pay the 50 RON deposit here: <url>, held for 30 minutes"
customer pays
  Stripe -> POST /api/webhooks/stripe  checkout.session.completed
    verify t=,v1= signature; ingest; handler markPaid
    payment PAID; booking PENDING -> CONFIRMED (holdExpiresAt cleared)
customer never pays
  either Stripe: checkout.session.expired -> payment EXPIRED, booking CANCELLED
  or cron: releaseExpiredHolds cancels the booking, sweepPayments expires the payment
customer cancels a paid booking
  cancelBookingAndRefund -> engine cancels -> gateway.createRefund
    succeeded -> REFUNDED now; pending -> REFUND_PENDING, cron retries
  Stripe later: charge.refunded -> markRefunded (no-op if already REFUNDED)
```

## Things to notice

- **Nothing is written on the customer's word.** PENDING is created by the engine,
  CONFIRMED only by a verified Stripe event (or the fake page, which produces exactly
  such an event, signed with our own secret).
- **Every transition checks the current status** before writing. That is what makes
  redelivery, the sweeper and the return page all safe to run more than once.
- **Metadata is the join.** `bookingId` goes on the session and on the payment intent, so
  a `charge.refunded` can find its payment and so the webhook layer has a correlation key
  to defer on when events arrive out of order.
- **The chat brain does not know about money.** `confirm_booking` returns
  `payment: { url, amount, hold_minutes }` when a deposit is due and the scripted brain
  (and the prompt rule for Claude) relay it. The tool contract carried the feature.

## Try it locally (no Stripe account)

`STRIPE_WEBHOOK_SECRET` is set in `.env` and `STRIPE_SECRET_KEY` is not, so the gateway
is in fake mode. In the Simulator: "book a haircut + beard on tuesday" (that service has
a 20 RON deposit), pick a time, tap Yes. The reply contains a `/pay/cs_fake_...` link;
open it, press "Pay now (simulated)". The booking flips to CONFIRMED, and Events shows
a `stripe` `checkout.session.completed` event PROCESSED. Cancel the booking from its
page: the deposit shows REFUNDED.

## Real Stripe (still free)

Stripe test mode is free. Create an account, copy the test secret key, run
`stripe listen --forward-to localhost:3000/api/webhooks/stripe` for a local webhook
secret (or configure the endpoint in the dashboard once deployed), and set
`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `APP_URL`. Test card `4242 4242 4242 4242`.

## Self-test

1. Why is the hold 30 minutes and not 10?
2. What happens if `checkout.session.completed` arrives twice?
3. A customer pays at minute 31, after the cron released the hold. What state does everything end in?
4. Why does the owner's dashboard booking skip the deposit, and where is that decided?
5. The refund cutoff now lives in `refundDeposit`'s policy argument (learning note 09). Why does the
   owner's cancel bypass it while the API's applies it, when both call the same function?
