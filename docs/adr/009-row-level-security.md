# ADR-009: RLS on every table; a tenant role scoped by a transaction setting

Status: accepted
Date: 2026-09-12

## Context

On Supabase, every table in `public` is reachable through PostgREST with the publishable
anon key. With RLS off, that key reads and writes everything. The app itself never uses
PostgREST (Prisma connects as the table owner), so the risk is not the app but the door
Supabase leaves open. Separately, the product is single-tenant for the demo but the
schema is multi-tenant (`business_id` everywhere), and a database-level guard against
cross-tenant reads is worth having before anyone relies on application code alone.

## Decision

One hand-written migration:

1. **`ENABLE ROW LEVEL SECURITY` on every table.** With no policies for `anon` or
   `authenticated`, PostgREST gets nothing. The owner role Prisma uses is exempt from
   RLS (no `FORCE`), so the app is unchanged.
2. **A `app_tenant` role with `tenant_isolation` policies.** Tables with `business_id`
   are scoped to `NULLIF(current_setting('app.business_id', true), '')::uuid`; child
   tables without it (`service_staff`, `booking_resources`, `calendar_events`) are scoped
   through their parent with `EXISTS`; global operational tables (`webhook_deliveries`,
   `inbound_events`) grant the tenant role nothing. `businesses` itself is scoped by id.
3. **Scoping is per transaction**: `SET LOCAL ROLE app_tenant; SET LOCAL app.business_id
= '<id>'`. `NULLIF` because a setting that was `SET LOCAL` earlier in a pooled session
   reads back as `''` rather than `NULL` after that transaction ends, and `''::uuid` is
   an error rather than "no rows".

The app does not switch to `app_tenant` today. The role exists so that going
multi-tenant is a change to the Prisma client setup (one transaction wrapper), not a
schema project, and so the policies are exercised now: `tests/integration/rls.test.ts`
proves isolation, denial without a business id, insert rejection, parent scoping, and
that the owner role is unaffected.

## Consequences

- Deploying to Supabase is safe by default: the anon key sees nothing.
- The tenant role cannot be used with the transaction pooler's connection reuse unless
  every request sets both `SET LOCAL`s; that is the wrapper mentioned above.
- `prisma migrate diff` does not know about policies or roles; they live only in the
  migration SQL and would need to be re-declared in any future `migrate reset`-style
  rebuild (they are, since they are in the migrations folder).
- Enabling RLS adds a per-row policy check only for non-owner roles; the app's own
  queries are not slowed.
