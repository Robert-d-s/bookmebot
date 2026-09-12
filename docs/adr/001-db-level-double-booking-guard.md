# ADR-001: Exclusion constraints, not unique indexes, guard double-booking

Status: accepted
Date: 2026-09-12

## Context

Bookings have variable durations (20 to 50+ minutes) and start on a 15-minute grid. A
unique index on `(staff_id, starts_at)` would only stop two bookings starting at the
exact same instant; a 30-minute booking at 09:00 and a 20-minute one at 09:15 would both
be accepted. Application-level checks alone are not enough either: two concurrent
requests can both read "free" and both insert.

## Decision

Use PostgreSQL range exclusion constraints (extension `btree_gist`):

```sql
ALTER TABLE bookings ADD CONSTRAINT bookings_no_staff_overlap
  EXCLUDE USING gist (
    staff_id WITH =,
    tstzrange(starts_at, ends_at, '[)') WITH &&
  ) WHERE (status IN ('PENDING', 'CONFIRMED'));
```

The same constraint exists on `booking_resources` for physical resources. Because that
table needs the time range without a join, a trigger copies `starts_at`, `ends_at` and an
`active` flag from the parent booking on every insert/update.

The constraint is the **last line of defence**. The scheduling engine (phase 1) still
serialises writes per staff with an advisory lock and checks availability, buffers and
opening hours, which the constraint knows nothing about. The constraint guarantees that
even a bug in that code cannot produce a double booking.

## Consequences

- Prisma cannot declare exclusion constraints or triggers, so the first migration is
  hand-edited SQL. `prisma migrate diff` will not try to drop them because they are not
  in the Prisma schema's model of the world, but any future `migrate reset` re-applies
  them from the migration file.
- Buffers are deliberately excluded from the constraint: two appointments may touch
  back-to-back at the DB level; the engine decides whether a buffer should separate
  them.
- A violation surfaces as SQLSTATE `23P01`, which the engine maps to `SlotTakenError`.
