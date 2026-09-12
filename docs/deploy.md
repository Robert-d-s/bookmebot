# Deploying (Vercel Hobby + Supabase free tier)

Everything below is free. Run once; afterwards every push to `main` deploys.

## 1. Supabase project

1. Create a project (region close to you). Note the database password.
2. Project settings, Database, Connection string. You need two URLs:
   - `DATABASE_URL`: **Transaction** pooler, port 6543, plus
     `?pgbouncer=true&connection_limit=1`.
   - `DIRECT_URL`: **Session** pooler, port 5432 on the same `*.pooler.supabase.com` host.
     (The `db.<ref>.supabase.co` host is IPv6-only on the free tier; avoid it.)
3. Apply migrations and seed from your machine:
   ```bash
   DIRECT_URL="<session pooler url>" DATABASE_URL="<session pooler url>" \
     SEED_OWNER_PASSWORD="choose-a-real-one" pnpm db:deploy && pnpm db:seed
   ```
   `btree_gist` is enabled by the first migration; Supabase allows it. The RLS migration
   creates the `app_tenant` role and enables RLS on every table, which is what keeps the
   Supabase anon key from reading your data through PostgREST (ADR-009).

## 2. Vercel project

1. Import the GitHub repo. Framework preset: Next.js. Build command stays `next build`
   (`postinstall` runs `prisma generate`).
2. Environment variables (Production):

   | Name                       | Value                              |
   | -------------------------- | ---------------------------------- |
   | `DATABASE_URL`             | transaction pooler URL from step 1 |
   | `DIRECT_URL`               | session pooler URL from step 1     |
   | `AUTH_SECRET`              | `openssl rand -base64 32`          |
   | `CRON_SECRET`              | `openssl rand -hex 32`             |
   | `WEBHOOK_SIMULATOR_SECRET` | `openssl rand -hex 32`             |

3. Deploy. Check `https://<app>/api/health` returns `{"ok":true,"db":"up"}` and
   `https://<app>/login` accepts `owner@frizeria.demo` with the seed password.

## 3. Scheduler

Vercel Hobby crons run at most once a day, so the retry sweeper is driven from GitHub
Actions instead (`.github/workflows/tick.yml`, every 5 minutes):

- Repository **variable** `APP_URL` = `https://<app>.vercel.app`
- Repository **secret** `CRON_SECRET` = same value as on Vercel

The workflow is skipped until `APP_URL` exists, so an undeployed fork stays quiet.

## 4. Later phases

- WhatsApp (phase 4): Meta app webhook URL is `https://<app>/api/webhooks/whatsapp`.
- Stripe (phase 6): `https://<app>/api/webhooks/stripe`.
- Sentry / PostHog (phase 8): more env vars, listed there.
