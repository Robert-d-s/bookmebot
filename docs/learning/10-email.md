# Learning note 10: Email (Resend)

Two jobs, one sender: sign-in links for the owner, and confirmations for customers who
book without WhatsApp. Resend's free tier covers both; without a key the sender logs.

## Shape

```
src/server/email/index.ts          EmailSender: Resend | Logging (captures; used in tests)
src/server/email/notifications.ts  notifyBookingConfirmed / notifyBookingCancelled, best-effort
src/server/auth/magic.ts           signed expiring token, sendMagicLink
src/app/auth/magic/                landing page with a "Continue" button
customers.email                    optional; asked on the public booking page
```

## Sign-in by link, without an adapter

Auth.js's own email providers need a database adapter for verification tokens, which
would mean adopting its user/account tables next to ours. Instead the token is
self-contained: `base64url({ email, expiresAt })` signed with `AUTH_SECRET`, 15-minute
life. The Credentials provider accepts either `{ email, password }` or `{ magicToken }`,
so the session that results is the same in both cases.

Two details worth copying:

- The link lands on a page with a button, not an auto sign-in. Corporate mail scanners
  prefetch links; a token consumed by a scanner would leave the owner with an "expired"
  message.
- The request form always says "if that address has an account, a link is on its way".
  It never reveals whether the address exists.

## Notifications

`createBooking` (confirmed path), `markPaid` (hold confirmed) and `cancelBookingAndRefund`
call the notifier without awaiting it, and the notifier never throws: a mail failure is
reported to Sentry, and the booking is unaffected. The customer's confirmation carries
the signed manage link from learning note 09; the cancellation states what happened to
the deposit. The owner is told about bookings from any source except the dashboard.

## Resend's free tier, honestly

3,000 emails a month, but until you verify a domain, delivery is only from
`onboarding@resend.dev` to the address that owns the Resend account. For the demo that
means the owner's own sign-in links and notifications arrive; a customer confirmation to
an arbitrary address will be rejected by Resend and show up as a reported error. A
verified domain (free, DNS records) lifts that.

## Try it

Without a key: request a link on `/login`; the URL is printed in the `pnpm dev` terminal.
Open it, press Continue. Book on `/book/frizeria-demo` with an email; the confirmation is
printed too. With `RESEND_API_KEY` set and your own address as the owner's email, the
same arrives in your inbox.

## Self-test

1. Why does the sign-in link need a button?
2. What stops someone from forging a magic token for the owner's address?
3. A confirmation email fails to send. What does the customer see, and what does the owner see?
4. Why are notifications fired without `await`?
