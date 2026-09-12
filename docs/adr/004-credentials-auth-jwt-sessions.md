# ADR-004: Credentials login with JWT sessions, guarded in the proxy

Status: accepted
Date: 2026-09-12

## Context

The dashboard needs an owner login. Auth.js v5 is the named stack. Its recommended
providers are OAuth (GitHub, Google) or email magic links. Both need a third-party
account and configuration before the first login works: an OAuth app, or a sending domain
verified with Resend. The demo has one owner and must run from a fresh clone with
`pnpm db:seed`.

## Decision

- **Credentials provider** (email + bcrypt hash in `users`) with **JWT sessions**. No
  database session table, no adapter. The seed creates `owner@frizeria.demo`.
- **`users.business_id`** on every login row, copied into the JWT and the session, so every
  dashboard query and action is scoped by `session.user.businessId`. Single-tenant today,
  but adding a second business is a data change.
- **Two config files.** `auth/config.ts` has callbacks and pages and no database imports;
  `auth/index.ts` adds the Credentials provider with Prisma and bcrypt. `src/proxy.ts`
  (Next 16's renamed middleware) builds Auth.js from the light config and protects
  `/dashboard/*` through the `authorized` callback, so the proxy bundle stays free of
  Prisma.
- Server actions call `requireUser()` first, always. The proxy is a convenience for
  redirects, not the security boundary: actions and pages check the session themselves.

## Consequences

- Swapping in GitHub or Google login is one provider entry and no schema change; the
  JWT callback already copies `businessId` from the user row.
- Passwordless sign-in was added later without an adapter: the Credentials provider also
  accepts a signed, expiring `magicToken` emailed via Resend (learning note 10).
- JWT sessions cannot be revoked server-side before expiry (30 days by default). For a
  demo this is acceptable; a session table via `@auth/prisma-adapter` is the fix if it
  ever matters.
- The cron and admin API routes keep their bearer secret (ADR-003); the dashboard's own
  events page uses the session instead.
- `trustHost: true` is set so the app works behind any host header (Vercel, local
  port). Auth.js reads `AUTH_SECRET` from the environment; `src/env.ts` validates it.
