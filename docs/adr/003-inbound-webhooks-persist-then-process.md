# ADR-003: Inbound webhooks are persisted first, processed second, claimed by status

Status: accepted
Date: 2026-09-12

## Context

Three integrations deliver events by webhook: WhatsApp (Meta), payments (Stripe) and
calendar (Google). All three retry on non-2xx, redeliver the same event more than once,
batch several events in one POST, and make no ordering promise. Handling those four
properties separately in each integration would triple the code and the bugs.

The hosting target is serverless (Vercel functions), so there is no long-running worker
process, and the free tier gives one scheduled invocation, not a queue.

## Decision

One layer, two steps, one table of truth.

1. **Ingest** (`ingest.ts`). Store the raw delivery (body, safe headers, signature
   result) before doing anything else. Verify the signature with the provider's adapter.
   Split the body into events and insert them with `createMany ... skipDuplicates` under a
   unique `(provider, provider_event_id)` index, so redelivery is a no-op decided by the
   database. Answer 200 as soon as the rows exist.

2. **Process** (`process.ts`). Claim an event with
   `UPDATE ... SET status = PROCESSING WHERE id = ? AND status IN (RECEIVED, FAILED, DEFERRED)`
   and only run the handler when that update touched a row. Record the handler's outcome:
   `processed`, `skipped`, `reject` are terminal; `retry` and `defer` schedule the next
   attempt with exponential backoff and become `DEAD` after five attempts.

Processing is triggered from three places, all safe together because of the claim:
`after()` in the route right after the response, the cron sweeper (`processDue`), and
admin replay.

**Out-of-order delivery** is handled with a `correlation_key` and a `DEFERRED` status.
A handler that needs a sibling it cannot find returns `defer`; when any event with the
same key is processed, deferred siblings are re-run immediately. The handler is what
knows which sibling it needs; the layer only knows how to wait and wake.

Providers plug in through a two-method interface (`verify`, `parse`) plus a handler,
registered by name. The simulator provider exists so the layer can be tested without any
external account.

## Consequences

- No event is lost after a 200: it is in the database before the response is written.
  A crashed handler costs a retry, not an event.
- Duplicates cost one insert attempt each and never reach a handler.
- Redelivery, retry and replay all go through the same claim, so a handler can assume
  it is the only one running for that event, but it must still be idempotent against
  side effects it made in a previous attempt that failed late (the simulator's cancel
  handler is: cancelling a cancelled booking is a no-op in the engine).
- Rejected signatures are stored as deliveries without events, which makes a
  misconfigured secret visible in the admin list instead of silently dropped.
- Backoff is 1, 2, 4, 8, 16 minutes with jitter. With a five-minute cron the practical
  retry cadence is coarser than that; fine for a demo, and the constants are in one place.
- The admin and cron routes are guarded by a shared bearer secret until phase 3 adds
  real sessions.
