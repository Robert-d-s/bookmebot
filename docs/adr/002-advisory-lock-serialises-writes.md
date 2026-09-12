# ADR-002: One advisory lock per business serialises booking writes

Status: accepted
Date: 2026-09-12

## Context

Reserving a slot is check-then-insert: read opening hours and existing bookings, decide
the slot is free, insert. Two concurrent requests can both pass the check. Options:

1. `SELECT ... FOR UPDATE` on the rows being checked. Does not work here: the conflict
   is with a row that does not exist yet, and locking "all bookings of staff X on day Y"
   still leaves the gap between "no rows" and "insert".
2. `SERIALIZABLE` isolation and retry on SQLSTATE `40001`. Correct, but the retry loop
   is more code, every loser pays a full transaction before finding out, and the
   transaction pooler on Supabase (pgbouncer, transaction mode) makes the failure mode
   harder to reason about.
3. Rely on the exclusion constraint alone (ADR-001) and map `23P01` to an error. Correct
   for staff and resource overlap, but the constraint knows nothing about opening hours,
   buffers, lead time or "pick any free staff / chair". Losers of the race for one chair
   would also have to retry to try the other chair.
4. A transaction-scoped advisory lock taken before the check.

## Decision

Option 4. `reserveSlot` and `rescheduleBooking` run in one interactive transaction that
starts with

```sql
SELECT pg_advisory_xact_lock(hashtext('bookings'), hashtext(<business_id>));
```

Everything after that line runs one writer at a time per business. The check reads
committed data under `READ COMMITTED`; because the previous holder committed before
releasing the lock, the check always sees the latest bookings. Losers fail the engine's
own check with `SlotUnavailableError` and a precise reason (`STAFF_BUSY`, `NO_RESOURCE`).
The exclusion constraint stays as the guard against anything that bypasses the engine;
if it ever fires it surfaces as `SlotTakenError`, and the concurrency test asserts it
does not.

The lock is per business, not per staff member, because resources (chairs) are shared
across staff: two writers on different staff can still fight over the last chair.

## Consequences

- Throughput per business is one booking write at a time. A barbershop books a few
  hundred appointments a week, so this is not a constraint in practice; measured on the
  laptop, 25 concurrent reservations complete in well under a second.
- The lock must be taken on the same connection as the rest of the transaction. Prisma's
  interactive transaction pins one connection, and the Supabase transaction pooler keeps
  a transaction on one backend, so this holds in both environments.
- The check and the generator share one predicate (`checkSlot`), so the engine never
  accepts a slot it would not have offered, and vice versa. A property test guards this.
- Reads (`getAvailability`) take no lock and may be slightly stale; the write is the
  source of truth, and the conversation layer must treat "slot gone" as a normal reply.
