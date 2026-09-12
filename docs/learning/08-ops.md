# Learning note 08: Ops

Row-level security, error reporting, product analytics, and what "deployed" means for
this project. All opt-in, all free.

## Row-level security

`prisma/migrations/*_row_level_security/migration.sql` enables RLS on every table and
defines an `app_tenant` role that sees one business at a time:

```sql
BEGIN;
SET LOCAL ROLE app_tenant;
SET LOCAL app.business_id = '<uuid>';
SELECT count(*) FROM bookings;      -- only that business
COMMIT;
```

Why it matters on Supabase: the anon key reaches PostgREST, and PostgREST reaches every
table in `public`. RLS on with no policy for `anon` means "nothing". The app is
unaffected because Prisma connects as the table owner, which RLS does not restrict.
`tests/integration/rls.test.ts` runs the `SET LOCAL` dance and checks six behaviours.

Gotcha worth remembering: `current_setting(name, true)` returns `NULL` for a setting
that was never set, but `''` for one that was `SET LOCAL` earlier in the same pooled
session. `''::uuid` throws. Hence `NULLIF(..., '')`.

## Sentry

`src/instrumentation.ts` initialises Sentry in `register()` and forwards Next's
`onRequestError`; `src/instrumentation-client.ts` does the browser. Both are no-ops
without a DSN. `reportError()` in `src/server/observability.ts` is called where errors
are swallowed on purpose: the API error mapper's 500 branch and the webhook processor's
retry branch, so a failing handler shows up in Sentry with the event id and provider
even though the HTTP response was a clean 200.

## PostHog

`src/server/analytics.ts` sends five server-side events keyed by business (not by
person): `booking_created` (with source and whether a deposit was taken),
`booking_cancelled`, `payment_paid`, `message_received` (channel, kind), `handoff`. Enough
for a funnel: messages -> bookings -> paid. Without `POSTHOG_KEY` nothing is sent; tests
inject a capturing client.

## Deploying

`docs/deploy.md` is the checklist: Supabase (two URLs), Vercel (env vars), the
GitHub Actions tick. Phase 8 adds the optional Sentry and PostHog variables to it. The
tick workflow doubles as the Supabase keep-alive: the free tier pauses projects after
a week without traffic, and a request every five minutes is traffic.

## What is deliberately not here

- No log shipping: Vercel's function logs plus Sentry cover a demo.
- No uptime monitor: `/api/health` is there for one; any free pinger works.
- No feature flags, no A/B: PostHog could, nothing needs it.

## Self-test

1. Why does enabling RLS not break the app on Supabase?
2. What does `FORCE ROW LEVEL SECURITY` change, and why was it not used?
3. A webhook handler throws. Where does that end up in Sentry, and what does the provider see?
4. Why are analytics events keyed by business rather than by customer phone?
5. What breaks first if the tick workflow stops running for two weeks?
