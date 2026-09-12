# BookMeBot

An AI receptionist for small service businesses that lives inside their WhatsApp number and
handles bookings, rescheduling and cancellations in conversation. Built as a learning and
portfolio project on a zero-cost stack, with the hard parts first: a concurrency-safe,
multi-resource scheduling engine and a webhook reliability layer.

## Stack

- Next.js 16 (App Router, route handlers, server actions), TypeScript, React 19, Tailwind v4
- PostgreSQL 16 with Prisma 7 (local Docker for dev and tests, Supabase free tier hosted)
- Auth.js v5, Resend, Meta WhatsApp Cloud API, Google Calendar API, Stripe (test mode)
- Vercel (Hobby) for hosting, GitHub Actions for CI and scheduled jobs

## Status

| Phase | Scope                                                                                  | State |
| ----- | -------------------------------------------------------------------------------------- | ----- |
| 0     | Foundation: repo, Postgres, Prisma schema v1, seed, CI                                 | done  |
| 1     | Scheduling engine: slots, reserve/cancel/reschedule, multi-resource, concurrency tests | done  |
| 2     | Webhook reliability layer: dedupe, retries, dead letters                               | done  |
| 3     | Auth + owner dashboard + first deploy                                                  | next  |
| 4     | WhatsApp channel + simulator channel                                                   |       |
| 5     | AI conversation layer (zero-spend providers)                                           |       |
| 6     | Payments: deposits and refunds via Stripe test mode                                    |       |
| 7     | Google Calendar two-way sync                                                           |       |
| 8     | Ops: RLS, Sentry, PostHog                                                              |       |

## Getting started

```bash
corepack enable                 # pnpm
cp .env.example .env
pnpm install                    # also generates the Prisma client
pnpm db:up                      # Postgres 16 in Docker on port 5433
pnpm db:migrate                 # apply migrations
pnpm db:seed                    # one demo barbershop
pnpm dev                        # http://localhost:3000
pnpm check                      # typecheck + lint + tests (what CI runs)
```

## Layout

```
src/app/            Next.js routes (dashboard UI, API route handlers)
src/server/         domain layer: scheduling, webhooks, customers, http helpers, ...
src/generated/      Prisma client (generated, not committed)
prisma/             schema, migrations (some hand-written SQL), seed
tests/              unit (pure + property), integration (real Postgres), concurrency
docs/learning/      one note per phase explaining what was built and why
docs/adr/           architecture decision records
```

## Design notes

- [ADR-000](docs/adr/000-backend-inside-nextjs.md): backend inside Next.js
- [ADR-001](docs/adr/001-db-level-double-booking-guard.md): exclusion constraints guard double-booking
- [ADR-002](docs/adr/002-advisory-lock-serialises-writes.md): one advisory lock per business serialises writes
- [ADR-003](docs/adr/003-inbound-webhooks-persist-then-process.md): webhooks are persisted first, processed second
- [Learning note 00](docs/learning/00-foundation.md): foundation
- [Learning note 01](docs/learning/01-scheduling-engine.md): scheduling engine
- [Learning note 02](docs/learning/02-webhook-reliability.md): webhook reliability layer

## API (no auth yet; cron and admin routes take `Authorization: Bearer $CRON_SECRET`)

| Method | Path                | Purpose                                                                             |
| ------ | ------------------- | ----------------------------------------------------------------------------------- |
| GET    | `/api/availability` | bookable slots for a service, `business`, `service`, optional `staff`, `from`, `to` |
| POST   | `/api/bookings`     | reserve a slot; customer identified by E.164 phone                                  |
| PATCH  | `/api/bookings/:id` | reschedule, optionally to another staff or `"any"`                                  |
| DELETE | `/api/bookings/:id` | cancel                                                                              |
