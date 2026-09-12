# Learning note 03: Auth and the owner dashboard

The first visible surface. It exists to prove the engine and the webhook layer through
real forms, and to be the thing you demo. Everything is server-rendered: no client
components, no fetch calls, no state library.

## Shape

```
src/server/auth/config.ts       Auth.js callbacks (no DB); used by the proxy
src/server/auth/index.ts        + Credentials provider (Prisma, bcrypt); used by routes/actions
src/server/auth/session.ts      requireUser(): session or redirect("/login")
src/proxy.ts                    protects /dashboard/* before rendering
src/app/login/                  form -> loginAction -> signIn("credentials")
src/app/dashboard/
  layout.tsx                    nav + sign out; requireUser() once for every page
  page.tsx                      schedule: one column per staff member for a local date
  bookings/new/page.tsx         service + staff + date -> slots -> customer -> reserveSlot
  bookings/[id]/page.tsx        detail, reschedule (slot buttons), cancel
  customers/page.tsx            customers with booking counts
  settings/page.tsx             opening hours, services (+ who performs them), staff, resources
  events/page.tsx               inbound events with status filter and "replay now"
  actions.ts                    every mutation: requireUser -> zod -> domain call -> revalidate/redirect
src/server/dashboard/queries.ts read models, all scoped by businessId
```

## Patterns worth copying

- **Forms without JavaScript.** Filters are `<form>` with GET; the URL is the state
  (`?date=`, `?service=&date=&start=`). Mutations are `<form action={serverAction}>`.
  Each slot on the reschedule panel is its own tiny form with hidden inputs, so
  "move to 11:15" is one click and no client code.
- **Errors travel in the URL.** An action that fails redirects back with
  `?error=<message>`; the page renders it with `<Flash>`. Success uses `?ok=`. This keeps
  actions free of React state and works with the back button.
- **A redirect is a throw.** Both `redirect()` and Auth.js's `signIn()` succeed by
  throwing. Any `try/catch` around them must re-throw `NEXT_REDIRECT` (see `isRedirect`
  in `actions.ts` and the `AuthError` check in `login/actions.ts`).
- **Same engine, same errors.** `createBookingAction` calls the same `reserveSlot` as the
  API and the simulator webhook. A slot that just went shows "Slot unavailable:
  STAFF_BUSY" in the form, produced by the same `SlotUnavailableError`.
- **Optimistic version on edits.** Cancel and reschedule forms carry the booking's
  `version`; the engine refuses if someone else changed it in between
  (`VersionConflictError`).

## Time on screen

Bookings are stored in UTC and rendered with `Intl.DateTimeFormat` in the business's
zone. The schedule page picks the day window with `localDayWindow`, so "Monday" is
Monday in Bucharest, not in UTC.

## Deploy readiness

`docs/deploy.md` has the Vercel + Supabase steps; `.github/workflows/tick.yml` calls the
cron route every five minutes once `APP_URL` and `CRON_SECRET` are set on the repo.
Nothing in the app is host-specific.

## Try it

```bash
pnpm db:seed && pnpm dev
open http://localhost:3000/login      # owner@frizeria.demo / demo-password
```

Book something on the next weekday, cancel it, replay a dead event, change opening hours
and watch the slot picker change.

## Self-test

1. Why does the proxy use a config without the Credentials provider?
2. What stops a logged-in owner of business A from opening a booking of business B by id?
3. What happens if a server action catches every error, including the one `redirect()` throws?
4. Where would you add a second login provider, and what schema change does it need?
5. Two owners open the same booking; one cancels, the other reschedules. What does the second see?
