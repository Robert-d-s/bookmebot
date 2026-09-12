# Learning note 09: Three extensions

Small follow-ups that each touch several layers, which is the point: they show where
the seams are.

## 1. Refund cutoff

`businesses.refund_cutoff_hours` (default 24, editable under Settings, Booking rules).
`refundDeposit(bookingId, now, policy)` gained a policy: `"apply"` keeps a paid deposit
as `FORFEITED` when the cancellation is inside the cutoff; `"always"` refunds
regardless. Who passes which:

| Path                          | Policy | Why                                   |
| ----------------------------- | ------ | ------------------------------------- |
| Dashboard cancel (owner)      | always | the owner's call                      |
| API `DELETE`, public manage   | apply  | customer-initiated                    |
| Chat `cancel_booking` tool    | apply  | customer-initiated; result says which |
| Simulator `booking.cancelled` | apply  | mimics a customer                     |

`cancelBookingAndRefund` now returns `deposit` (`REFUNDED`, `FORFEITED`, ...) so every
surface can tell the customer what happened without reading the payment row. The chat
brain says "Since this is inside the cancellation cutoff, the deposit is not refunded."

## 2. Public booking page

`/book/<slug>`: the same four steps as the dashboard's New booking (service, day, time,
details), with no login, and the same `createBooking` underneath, so deposits work: a
deposit service sends the customer to the pay page and the booking is a 30-minute hold
until paid. The confirmation page gives a **manage link**, the booking id signed with
`AUTH_SECRET` (`bookings/token.ts`). Knowing an id is not enough to cancel; knowing the
link is. Cancelling there applies the refund cutoff and the page says up front whether
the deposit will be refunded.

Try it: `/book/frizeria-demo`.

## 3. Per-staff calendars

`calendar_connections` is no longer one per business: `staff_id` is null for the shared
calendar (uniqueness enforced by a partial index, since NULLs are distinct) or set for
a staff member's own. Routing:

- **Push**: `connectionFor(businessId, staffId)` picks the staff member's calendar if
  connected, else the shared one. If a booking's mirror is in the wrong calendar
  (staff changed, or a staff calendar was connected after the fact), `pushBooking`
  removes it from the old calendar and inserts into the right one; `syncDue` finds those
  with one more SQL join.
- **Pull**: a block from a staff calendar carries `staff_id`, and the engine adds it only
  to that person's busy list; blocks from the shared calendar apply to everyone.

The Calendar page shows one row per calendar with connect/disconnect, and the demo
block form lets you pick which calendar to block. Real Google OAuth is still wired to
the shared calendar only; per-staff Google would need each staff member to complete the
consent flow, which is a `staffId` on the OAuth state.

## Self-test

1. Why does the owner's cancellation ignore the cutoff while the API's applies it, when both call the same function?
2. What does the manage link protect against, and what does it not protect against?
3. A staff member connects their calendar after a month of bookings. What happens on the next sweep?
4. Why is the shared-calendar uniqueness a partial index instead of `@@unique`?
