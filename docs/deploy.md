# Deploying (Vercel Hobby + Supabase free tier)

Everything below is free. Do it once; afterwards every push to `main` deploys.
Nothing in the app is host-specific, so any Node host plus any Postgres works too.

## 0. Before you start

- The app works locally with no external accounts (`README.md`, Getting started).
  Deploying only adds a public URL; every integration stays optional.
- `pnpm db:seed` **wipes and recreates** the demo business `frizeria-demo`. Run it once
  on a fresh database, not after real bookings exist.

## 1. Supabase project

1. Create a project (region close to you). Note the database password.
2. Project settings, Database, Connection string. You need two URLs:
   - `DATABASE_URL`: **Transaction** pooler, port 6543, with
     `?pgbouncer=true&connection_limit=1` appended. The app uses this at runtime.
   - `DIRECT_URL`: **Session** pooler, port 5432 on the same `*.pooler.supabase.com`
     host. Migrations use this. (The `db.<ref>.supabase.co` host is IPv6-only on the
     free tier; avoid it.)
3. Apply migrations and seed from your machine, pointing both variables at the
   **session** pooler for this one-off (the seed script uses `DATABASE_URL`):
   ```bash
   DIRECT_URL="<session pooler url>" DATABASE_URL="<session pooler url>" \
   SEED_OWNER_PASSWORD="choose-a-real-one" \
     sh -c 'pnpm db:deploy && pnpm db:seed'
   ```
   - `btree_gist` is enabled by the first migration; Supabase allows it.
   - The RLS migration enables row-level security on every table and creates the
     `app_tenant` role. That is what stops the Supabase anon key from reading your data
     through PostgREST (ADR-009). The app is unaffected: it connects as the table owner.
   - If you already have a Meta test number, set `WHATSAPP_PHONE_NUMBER_ID` in the same
     command so the seed stores it on the demo business (learning note 04).

## 2. Vercel project

1. Import the GitHub repo. Framework preset: Next.js. Build command stays `next build`;
   `postinstall` runs `prisma generate`. Node 20 or later.
2. Environment variables (Production). **Required:**

   | Name                       | Value                                                                        |
   | -------------------------- | ---------------------------------------------------------------------------- |
   | `DATABASE_URL`             | transaction pooler URL from step 1                                           |
   | `DIRECT_URL`               | session pooler URL from step 1                                               |
   | `AUTH_SECRET`              | `openssl rand -base64 32`                                                    |
   | `CRON_SECRET`              | `openssl rand -hex 32`                                                       |
   | `WEBHOOK_SIMULATOR_SECRET` | `openssl rand -hex 32`                                                       |
   | `APP_URL`                  | `https://<app>.vercel.app` (pay links, manage links, OAuth redirects use it) |

   **Optional, each one switches a feature on** (details in the learning note named):

   | Feature                   | Variables                                                                                                            | Note |
   | ------------------------- | -------------------------------------------------------------------------------------------------------------------- | ---- |
   | Chat brain: Claude        | `ANTHROPIC_API_KEY`, optional `LLM_MODEL` (default `claude-opus-5`)                                                  | 05   |
   | Chat brain: free endpoint | `LLM_PROVIDER=openai-compatible`, `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`                                         | 05   |
   | WhatsApp                  | `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_ACCESS_TOKEN`, optional `WHATSAPP_GRAPH_VERSION`           | 04   |
   | Deposits (Stripe test)    | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`                                                                         | 06   |
   | Google Calendar           | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`                                                                           | 07   |
   | Error reporting           | `SENTRY_DSN`, `NEXT_PUBLIC_SENTRY_DSN`; `SENTRY_AUTH_TOKEN`/`SENTRY_ORG`/`SENTRY_PROJECT` only for source-map upload | 08   |
   | Product analytics         | `POSTHOG_KEY`, optional `POSTHOG_HOST` (default EU)                                                                  | 08   |

   Without any optional variable: the scripted brain answers chats, deposits are
   skipped, no calendar sync, no reporting. Everything else works.

3. Deploy, then verify:
   - `https://<app>/api/health` returns `{"ok":true,"db":"up"}`
   - `https://<app>/login` accepts `owner@frizeria.demo` with your seed password
   - `https://<app>/book/frizeria-demo` shows the public booking page
   - `curl -H "Authorization: Bearer $CRON_SECRET" https://<app>/api/cron/tick`
     returns a JSON summary

## 3. Scheduler (GitHub Actions)

Vercel Hobby crons run at most once a day, so `.github/workflows/tick.yml` calls the
cron route every 5 minutes instead. It retries due webhook events, releases expired
booking holds, sweeps payments, syncs calendars, and, as a side effect, keeps the
Supabase free-tier project from pausing for inactivity. Configure on the repo:

- Settings, Secrets and variables, Actions, **Variables**: `APP_URL` = `https://<app>.vercel.app`
- **Secrets**: `CRON_SECRET` = the same value as on Vercel

The workflow is skipped until `APP_URL` exists, so an undeployed fork stays quiet.
Run it once by hand from the Actions tab to confirm a green tick.

## 4. Connecting real integrations (any time after deploy)

| Integration | Where to point it                                                                                                                                                                      | Then             |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| WhatsApp    | Webhook URL `https://<app>/api/webhooks/whatsapp`, verify token = `WHATSAPP_VERIFY_TOKEN`, subscribe to `messages`                                                                     | learning note 04 |
| Stripe      | Endpoint `https://<app>/api/webhooks/stripe`, events `checkout.session.completed`, `checkout.session.expired`, `charge.refunded`; copy the signing secret into `STRIPE_WEBHOOK_SECRET` | learning note 06 |
| Google      | OAuth client redirect URI `https://<app>/api/integrations/google/callback`; connect from Dashboard, Calendar                                                                           | learning note 07 |

Changing an environment variable on Vercel needs a redeploy to take effect.

## 5. Updating

- Code: push to `main`. CI runs typecheck, lint, tests and a build; Vercel deploys
  independently of CI, so watch both.
- Schema: the build does **not** run migrations. Before pushing a change that adds a
  migration, apply it to Supabase from your machine:
  ```bash
  DIRECT_URL="<session pooler url>" pnpm db:deploy
  ```
  Migrations here are additive, so applying them before the deploy is safe.

## 6. Troubleshooting

- **Boot fails with an env error**: `src/env.ts` validates every variable at startup and
  names the missing or malformed one in the function logs.
- **`prepared statement already exists` or advisory-lock errors on Supabase**: the runtime
  URL must be the _transaction_ pooler with `pgbouncer=true`, and migrations must use the
  _session_ pooler. The two must not be swapped.
- **Project paused**: Supabase pauses free projects after a week without traffic. The tick
  workflow prevents that; if it was off, unpause from the Supabase dashboard.
- **Payment links point at localhost**: `APP_URL` is unset or wrong on Vercel.
