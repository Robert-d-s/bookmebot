# ADR-008: Calendar push keyed on booking version; pulled time becomes engine blocks

Status: accepted
Date: 2026-09-12

## Context

Owners live in Google Calendar. Confirmed bookings must appear there, and time they
block there must stop being offered here. Writes to bookings happen in five places
(engine API, dashboard, chat tools, simulator, payment webhook), and Google's API is
rate-limited and occasionally down, so a synchronous "call Google inside the booking
transaction" would couple every booking to Google's uptime.

## Decision

- **Push is reconciliation, not events.** `calendar_events` records, per booking, which
  external event mirrors it and which `booking.version` that mirror reflects. Anything
  active without a mirror, or whose version differs, or whose last push failed, is due.
  The cron sweep pushes what is due; hot paths call `pushSoon` for immediacy but never
  wait on it. No write path needs a hook, and a Google outage means "stale for a few
  minutes", not "booking failed".
- **Only CONFIRMED, COMPLETED and NO_SHOW are pushed.** A PENDING deposit hold is not
  an appointment yet; it is pushed when the payment webhook confirms it (which bumps
  the version, so the sweep picks it up). CANCELLED deletes the mirror.
- **Our events are tagged** (`extendedProperties.private.bookmebot = "1"`, plus the
  booking id). The pull side skips tagged events, which is the whole of echo-loop
  prevention. An event the owner deleted by hand is recreated on the next change.
- **Pull produces `calendar_blocks`**, business-wide busy intervals the engine adds to
  every staff member's busy list. One calendar per business keeps this simple; per-staff
  calendars would be a `staffId` on the block. Incremental sync uses Google's sync
  token; a 410 falls back to a full listing of the booking window, which is then treated
  as the truth (blocks that vanished are dropped).
- **A `CalendarApi` interface with a Google implementation and an in-memory fake** that
  reproduces incremental-sync semantics, including cancellations and token expiry. The
  dashboard offers "Connect demo calendar" when Google credentials are absent, so the
  full loop, including "block time in the calendar and watch the slot disappear", is
  demoable locally.
- **OAuth**: standard web flow, offline access, tokens on `calendar_connections`,
  refresh on demand, state = business id signed with `AUTH_SECRET`.

## Consequences

- Sync lag is bounded by the cron interval (5 minutes deployed, `pnpm tick --watch`
  locally) plus the immediate best-effort push.
- Blocks are opaque busy time: the engine reports `STAFF_BUSY` for them, which is what
  the customer should hear anyway.
- Google's push notifications (watch channels) are not used; polling with sync tokens is
  simpler and fits the free tier. A watch channel would only shorten pull lag.
- Real Google needs a Cloud project with the Calendar API enabled and an OAuth client in
  testing mode with the owner as a test user; nothing costs money.
