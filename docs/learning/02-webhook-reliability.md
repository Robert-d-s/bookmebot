# Learning note 02: Webhook reliability layer

Built once, before any provider is wired, so WhatsApp, Stripe and Google Calendar all
inherit the same guarantees. Everything in `src/server/webhooks`.

## Shape

```
types.ts        Provider (verify, parse) and Handler (event -> outcome) contracts
registry.ts     providers and handlers by name
signature.ts    HMAC-SHA256 + constant-time compare (Meta's exact scheme)
ingest.ts       persist delivery + events, dedupe, answer
process.ts      claim, run handler, record outcome, backoff, defer/wake, sweep, replay
providers/      simulator; whatsapp (learning note 04) and stripe (06) register here too.
                Google Calendar is polled, not a webhook (07).
```

Routes: `POST /api/webhooks/[provider]` (receiver), `GET /api/cron/tick` (sweeper plus
hold release), `GET /api/admin/events` and `POST /api/admin/events/[id]/replay`
(dead-letter inspection and replay). Cron and admin need `Authorization: Bearer $CRON_SECRET`.

## Lifecycle of one event

```
POST arrives
  webhook_deliveries row (raw body, signature ok?)     always, even on bad signature
  inbound_events rows, one per event, RECEIVED         skipDuplicates on (provider, event id)
  200
after response:
  claim: UPDATE ... WHERE status IN (RECEIVED, FAILED, DEFERRED)  -> PROCESSING
  handler(event) -> processed | skipped | retry | defer | reject   (throw = retry)
  PROCESSED / SKIPPED / FAILED+next_attempt_at / DEFERRED+next_attempt_at / DEAD
  if processed and correlation_key: re-run DEFERRED siblings now
cron tick:
  processDue(): every RECEIVED, or FAILED/DEFERRED with next_attempt_at <= now
```

## The five outcomes and why `skipped` is not `retry`

| Outcome     | Meaning                                           | Next                                  |
| ----------- | ------------------------------------------------- | ------------------------------------- |
| `processed` | side effect done; `result` stored                 | terminal; wakes deferred siblings     |
| `skipped`   | nothing to do, and never will be (engine said no) | terminal, no error                    |
| `retry`     | transient (upstream 503, DB hiccup)               | backoff, DEAD after 5                 |
| `defer`     | needs a sibling that has not arrived              | backoff, DEAD after 5, or woken early |
| `reject`    | poison payload                                    | DEAD immediately                      |

A slot that is taken is a `skipped`, not a `retry`: retrying it would never succeed and
would only delay the reply the customer is waiting for. The conversation layer (phase 5)
turns `skipped` reasons into wording.

## Idempotency lives in the database

The unique index on `(provider, provider_event_id)` plus `createMany({ skipDuplicates })`
means the code never asks "have I seen this?". It inserts, and the answer is the count.
The same idea makes the claim atomic: an `updateMany` guarded by the current status
either touches one row or none, so ten concurrent workers produce one handler call
(`tests/integration/webhooks.test.ts`, "claims atomically").

## Out-of-order: cancel before create

The simulator's `booking.cancelled` handler looks for the processed `booking.requested`
with the same `clientRef` and reads the booking id from its stored `result`. If it is
not there yet, it returns `defer`. When the create is processed, the layer re-runs the
deferred cancel at once. The event log is the source of truth for the mapping between
the external reference and our booking id; no extra column on `bookings` was needed.

## Serverless notes

- `after()` from `next/server` runs the handler once the response has gone out, inside
  the same invocation. If the platform kills the function first, the event is still
  RECEIVED and the sweeper picks it up.
- There is no queue. The cron tick is the queue. On Vercel Hobby that is one daily cron,
  so a GitHub Actions schedule (every 5 minutes is the minimum) calls the tick once the
  app is deployed (`docs/deploy.md`).

## Try it

```bash
pnpm dev
set -a; source .env; set +a
BODY='{"events":[{"id":"e1","type":"booking.cancelled","data":{"clientRef":"demo-1"}}]}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$WEBHOOK_SIMULATOR_SECRET" | awk '{print $2}')
curl -X POST localhost:3000/api/webhooks/simulator -H "x-signature: sha256=$SIG" --data-binary "$BODY"
curl -H "authorization: Bearer $CRON_SECRET" "localhost:3000/api/admin/events?status=DEFERRED"
```

Then send a `booking.requested` with the same `clientRef` (see learning note 01 for the
service id and a valid `startsAt`) and list again: both PROCESSED, booking CANCELLED.

## Self-test

1. Why is the delivery row written before the signature is checked?
2. What would go wrong if the claim were `SELECT status` followed by `UPDATE`?
3. A handler booked a slot and then crashed before the outcome was recorded. What happens
   on the retry, and what property of the handler makes that safe?
4. Why is `skipped` terminal while `defer` is not?
5. The sweeper runs every 5 minutes but backoff starts at 1 minute. Does that break anything?
