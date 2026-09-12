# Learning note 00: Foundation

What this phase set up, why each piece is there, and what to look at first.

## What was built

| Piece                                        | Where                                            | Why                                                                                         |
| -------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| Next.js 16 app (App Router, TS, Tailwind v4) | `src/app`                                        | The ad's stack.                                                                             |
| Local Postgres 16                            | `docker-compose.yml`                             | Real DB for dev and for concurrency tests. Port 5433 to avoid clashing with other projects. |
| Prisma 7                                     | `prisma/schema.prisma`, `prisma.config.ts`       | ORM. Version 7 differs from the 5/6 you used in NestJS, see below.                          |
| Schema v1                                    | `prisma/schema.prisma`                           | Businesses, staff, resources, services, customers, bookings, availability.                  |
| Hand-written SQL in migration 0              | `prisma/migrations/*_init/migration.sql`         | Exclusion constraints and a trigger Prisma cannot express.                                  |
| Seed                                         | `prisma/seed.ts`                                 | One barbershop in Bucharest.                                                                |
| Env validation                               | `src/env.ts`                                     | Boot fails loudly on a missing variable.                                                    |
| Prisma client singleton                      | `src/server/db/prisma.ts`                        | One pool per process, survives hot reload.                                                  |
| Time helpers + unit tests                    | `src/server/scheduling/time.ts`, `tests/unit`    | First slice of the engine; proves DST handling.                                             |
| Constraint integration test                  | `tests/integration/exclusion-constraint.test.ts` | Proves the DB guard with real Postgres.                                                     |
| CI                                           | `.github/workflows/ci.yml`                       | Postgres service container, migrate, typecheck, lint, test, build.                          |
| Health route                                 | `src/app/api/health/route.ts`                    | First route handler; later the keep-alive target.                                           |

## Prisma 7 vs the Prisma 5/6 you know

- **No `url` in `schema.prisma`.** Connection settings live in `prisma.config.ts`. The URL
  there is used by the CLI only (migrate, seed, studio).
- **Driver adapters are mandatory.** The client is constructed with
  `new PrismaClient({ adapter: new PrismaPg({ connectionString }) })`. The Rust query
  engine is gone; queries are compiled in TypeScript and executed by `pg`.
- **Generator is `prisma-client` with a required `output`.** The client is generated into
  `src/generated/prisma` (gitignored, regenerated on `pnpm install`) and imported from
  `@/generated/prisma/client`, not from `@prisma/client`.
- **No automatic seeding.** `prisma migrate dev` no longer runs the seed; use `pnpm db:seed`.

## Why two connection URLs

`DATABASE_URL` is what the app uses at runtime. `DIRECT_URL` is what migrations use.
Locally they are identical. On Supabase they differ because the transaction pooler
(port 6543) does not support the session-level features `prisma migrate` needs
(prepared statements, advisory locks held across statements). Supabase's direct host is
IPv6-only on the free tier, so `DIRECT_URL` points at the **session pooler** on port 5432
instead. Details in `.env.example`.

## Schema decisions worth noticing

- **UTC everywhere, local only at the edges.** `bookings.starts_at` is `timestamptz`. Opening
  hours are minutes-from-local-midnight, because "09:00" must stay "09:00" across DST. The
  helpers in `time.ts` are the only place local and UTC meet.
- **Buffers live on the service, not in the booking range.** The DB constraint guards raw
  overlap; the engine adds buffers when computing free slots. This keeps the constraint
  simple and makes "back-to-back allowed?" a business rule instead of a schema rule.
- **`booking_resources` mirrors the parent's time range.** An exclusion constraint cannot
  join to another table, so a trigger keeps the copy in sync. The integration test proves
  the trigger works on reschedule and cancel.
- **`PENDING` counts as occupied.** That is what makes deposits-before-confirm (phase 6)
  safe: the slot is held while the customer pays; a sweeper releases expired holds.
- **`version` on bookings** is an optimistic-concurrency token used by the dashboard's edit forms and, later, by the calendar sync to detect changes.

## Dev loop

```bash
pnpm db:up          # start Postgres
pnpm db:migrate     # apply migrations (dev)
pnpm db:seed        # demo data
pnpm dev            # http://localhost:3000/api/health
pnpm check          # typecheck + lint + tests, same as CI
```

## Self-test

1. Why would a unique index on `(staff_id, starts_at)` not prevent double-booking?
2. What happens to a 09:00 opening time on the day Romania switches to summer time if you
   stored it as a UTC timestamp instead of minutes-from-midnight?
3. Why does the app connect on port 6543 but migrations on port 5432?
4. What does the `WHERE (status IN ...)` clause on the exclusion constraint achieve, and
   what would break without it?
5. Where does Prisma 7 look for `DATABASE_URL`, and where does the app look?
