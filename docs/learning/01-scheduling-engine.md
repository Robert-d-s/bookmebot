# Learning note 01: Scheduling engine

The hard part of the product, built before any UI. Everything in `src/server/scheduling`.

## Shape

```
time.ts          UTC <-> local edges (unchanged from phase 0)
availability.ts  weekly rules + overrides -> working windows        pure
slots.ts         windows + busy + buffers -> slots; checkSlot        pure
engine.ts        loads rows, runs the pure layer, writes in a tx    DB
errors.ts        typed failures, exclusion-violation detection
```

The split matters: the pure layer is where all the scheduling rules live and it is
tested with hand-built data and property tests in milliseconds. The engine only loads,
locks and writes.

## The rules, in one place

| Rule                    | Where                 | Detail                                                                                    |
| ----------------------- | --------------------- | ----------------------------------------------------------------------------------------- |
| Opening hours           | `workingWindows`      | business windows ∩ staff windows; overrides win; staff with no rules inherit the business |
| Grid                    | `checkSlot`           | anchored at each window's opening time, so 09:00, 09:15 ... survive DST                   |
| Buffers                 | `footprint`           | each booking owns its own before/after buffer; footprints must not overlap                |
| Lead time / max advance | `checkSlot`           | `now + minLeadMin <= start <= now + maxAdvanceDays`                                       |
| Resource                | `pickResource`        | first free resource of the required type; greedy, no optimisation                         |
| Any staff               | `chooseStaff`         | free staff with the fewest bookings loaded, ties by name                                  |
| PENDING holds           | DB constraint + sweep | count as occupied until `releaseExpiredHolds` cancels them                                |

Buffers are outside the DB constraint on purpose (ADR-001): 09:00-09:30 and 09:30-10:00
are legal rows, and whether a cleanup buffer should keep them apart is a business rule.

## One predicate, two callers

`generateSlots` walks the grid and keeps what `checkSlot` accepts. `reserveSlot` calls
the same `checkSlot` on the requested start inside the transaction. So there is no way
to offer a slot the engine will refuse, or to sneak in a slot it would not have offered.
`tests/unit/slots.test.ts` has a fast-check property for exactly this.

## The write path

```
BEGIN
  SELECT pg_advisory_xact_lock(hashtext('bookings'), hashtext(business_id))
  load business, service, eligible staff, rules, overrides, bookings ± 1 day, resources
  checkSlot for the requested start (given staff, or choose one)
  pickResource
  INSERT bookings (+ booking_resources; trigger copies the range)
COMMIT
```

Why the lock rather than `SELECT FOR UPDATE` or `SERIALIZABLE` is in ADR-002. What to
notice: losers do not hit the database constraint at all. They wait for the lock, then
run the same check against data that now includes the winner, and fail with a reason the
conversation layer can say out loud ("that time just went, how about 10:15?").

Reschedule is the same transaction with the booking's own range excluded from the busy
set, and with the old `booking_resources` row deleted _before_ the booking is updated.
The update fires the sync trigger, which would otherwise move the old chair's range and
could collide with a neighbour before the chair is swapped.

## Proof

- `tests/unit/availability.test.ts`: windows, overrides, split shifts, DST.
- `tests/unit/slots.test.ts`: grid, buffers, lead time, resources, and two properties.
- `tests/integration/engine.test.ts`: reserve / cancel / reschedule / holds on real Postgres,
  including "third booking fails with `NO_RESOURCE` while a staff member is free".
- `tests/concurrency/reserve-race.test.ts`: 25 parallel reservations. One staff: exactly
  one wins. Any staff with 3 staff and 2 chairs: exactly two win, on different chairs.
  Zero `SlotTakenError`, meaning the constraint never had to step in.

## Try it

```bash
pnpm dev
SLUG=frizeria-demo
SERVICE=$(docker exec bookmebot-db psql -U bookmebot -d bookmebot -Atc \
  "select id from services where name='Haircut'")
DAY=$(date -v+3d +%F)          # any weekday within the next 60 days (GNU: date -d +3days)
curl "localhost:3000/api/availability?business=$SLUG&service=$SERVICE&from=$DAY&to=$DAY"
START=$(curl -s "localhost:3000/api/availability?business=$SLUG&service=$SERVICE&from=$DAY&to=$DAY" \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['slots'][0]['start'])")
curl -X POST localhost:3000/api/bookings -H 'content-type: application/json' -d \
  "{\"business\":\"$SLUG\",\"service\":\"$SERVICE\",\"startsAt\":\"$START\",\"customer\":{\"phone\":\"+40721000009\",\"name\":\"Curl\"}}"
```

Then `DELETE /api/bookings/<id>?business=frizeria-demo` and
`PATCH /api/bookings/<id>` with `{ "business", "startsAt", "staff"? }`. No auth yet; that
is phase 3.

## Self-test

1. Why does the grid anchor at the window's opening time instead of at UTC midnight?
2. A 09:30 candidate for a service with a 10-minute cleanup buffer, next to a booking at
   10:00. Offered or not? What if the buffer were on the _existing_ booking instead?
3. Why is the advisory lock keyed by business and not by staff member?
4. In the reschedule transaction, what goes wrong if the booking row is updated before
   its `booking_resources` row is deleted?
5. The race test asserts zero `SlotTakenError`. What would a non-zero count tell you?
