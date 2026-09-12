# Learning note 07: Google Calendar two-way sync

Bookings go out as events; blocked time comes in as busy intervals. Everything is
reconciled by a sweep, so no write path has to know the calendar exists.

## Shape

```
src/server/calendar/api.ts     CalendarApi: Google (fetch, token refresh) | Fake (in-memory, sync tokens)
src/server/calendar/oauth.ts   consent URL, signed state, code exchange
src/server/calendar/sync.ts    pushBooking, syncDue, pullBlocks, syncCalendars, pushSoon
src/app/api/integrations/google/{connect,callback}
src/app/dashboard/calendar/    connect / sync now / blocks; demo controls with the fake
engine.ts                      calendar_blocks -> busy for every staff member
```

## Push, by version

```
booking.version   calendar_events.synced_version   action
      3                     (none)                  insert, record v3
      3                        3                    nothing
      4                        3                    update, record v4
   CANCELLED                   4                    delete, status DELETED
      5 (rescheduled)        DELETED                insert again
```

`syncDue` finds the first three cases with Prisma filters and the version mismatch with
one SQL statement, then calls `pushBooking` for each. Hot paths (`createBooking`,
`cancelBookingAndRefund`, `markPaid`, reschedule actions) call `pushSoon`, which is
`pushBooking` without awaiting. If Google is down, the mirror is marked FAILED and the
next sweep retries. Nothing about a booking ever waits on Google.

## Pull, with sync tokens

First pull: full listing of `[now, now + maxAdvanceDays]`, and that listing is treated
as the truth (blocks not in it are deleted). Every later pull sends the sync token and
gets only changes, including `status: cancelled` for deletions. Google eventually
answers 410 to an old token; the code clears it and does a full pull again. The fake
calendar implements exactly these semantics so the branch is tested.

Our own events come back in listings too. They carry
`extendedProperties.private.bookmebot = "1"`, and the pull skips them. That single check
is what stops the echo loop (push an event, pull it as a block, block the slot we booked).

## Try it (no Google account)

Dashboard, Calendar, "Connect demo calendar". Confirm a booking (Simulator or New
booking) and press "Sync now": it appears under Pushed bookings with a `fake_` id.
Reschedule it from its page, sync again: same id, version +1. Then "Block in demo
calendar" for tomorrow 12:00, 60 minutes: the block appears, and New booking no longer
offers 12:00-12:45 for anyone. Remove it in the calendar: the slots are back.

## Real Google (free)

Google Cloud console: new project, enable "Google Calendar API", OAuth consent screen
(External, Testing, add your Gmail as test user), Credentials, OAuth client ID (Web),
redirect URI `<APP_URL>/api/integrations/google/callback`. Put the id and secret in
`.env`, restart, Calendar, "Connect Google Calendar". Testing-mode refresh tokens expire
after 7 days unless the app is published; reconnecting is one click.

## Self-test

1. Why key the push on `booking.version` instead of listening for booking changes?
2. What happens if the sweep runs twice at the same time for the same booking?
3. The owner deletes a pushed event in Google, then the customer reschedules. Trace it.
4. Why is a full pull allowed to delete blocks, but an incremental pull only deletes what Google says is cancelled?
5. Per-staff calendars were added afterwards (learning note 09). Which two functions in `sync.ts`
   had to learn about `staffId`, and why did the engine need only a one-line change?
