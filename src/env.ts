import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

/**
 * Validated environment. Import `env` instead of reading process.env so a
 * missing or malformed variable fails at boot with a clear message rather
 * than as an undefined deep inside a request.
 *
 * Server-only variables are never exposed to the client bundle.
 */
export const env = createEnv({
  server: {
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    /** Runtime connection (Supabase: transaction pooler, port 6543). */
    DATABASE_URL: z.string().url(),
    /** Migration connection (Supabase: session pooler, port 5432). */
    DIRECT_URL: z.string().url(),
    /** Bearer token for /api/cron/* and /api/admin/* until real auth lands (phase 3). Vercel Cron sends it automatically. */
    CRON_SECRET: z.string().min(16),
    /** HMAC key for the simulator webhook provider. */
    WEBHOOK_SIMULATOR_SECRET: z.string().min(16),
    /** Auth.js JWT/cookie signing key. `openssl rand -base64 32`. */
    AUTH_SECRET: z.string().min(32),
    /** Meta app secret; signs inbound WhatsApp webhooks. Unset = provider refuses everything. */
    WHATSAPP_APP_SECRET: z.string().min(1).optional(),
    /** Token you type into the Meta webhook config; echoed back on the GET challenge. */
    WHATSAPP_VERIFY_TOKEN: z.string().min(1).optional(),
    /** Bearer token for the Graph API (temporary test token is fine for the demo). */
    WHATSAPP_ACCESS_TOKEN: z.string().min(1).optional(),
    /** Graph API version for outbound calls. */
    WHATSAPP_GRAPH_VERSION: z.string().default("v22.0"),
    /**
     * Which brain answers customers. "scripted" is a deterministic rule engine
     * (zero spend, used in CI); "anthropic" uses the Claude API and needs
     * ANTHROPIC_API_KEY (read by the SDK itself). Default: anthropic when a
     * key is present, otherwise scripted.
     */
    LLM_PROVIDER: z.enum(["scripted", "anthropic", "openai-compatible"]).optional(),
    LLM_MODEL: z.string().default("claude-opus-5"),
    ANTHROPIC_API_KEY: z.string().min(1).optional(),
    /** For openai-compatible: e.g. https://api.groq.com/openai/v1 (Groq free tier). */
    LLM_BASE_URL: z.string().url().optional(),
    LLM_API_KEY: z.string().min(1).optional(),
    /** Stripe test-mode keys. Unset = deposits are skipped and bookings confirm directly. */
    STRIPE_SECRET_KEY: z.string().min(1).optional(),
    STRIPE_WEBHOOK_SECRET: z.string().min(1).optional(),
    /** Public base URL used in Checkout success/cancel links. */
    APP_URL: z.string().url().default("http://localhost:3000"),
    /** Google OAuth web client for Calendar. Unset = demo (fake) calendar only. */
    GOOGLE_CLIENT_ID: z.string().min(1).optional(),
    GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
    /** Sentry (free tier). Server DSN; NEXT_PUBLIC_SENTRY_DSN for the browser. */
    SENTRY_DSN: z.string().url().optional(),
    /** Resend (free tier). Unset = emails are logged, not sent. */
    RESEND_API_KEY: z.string().min(1).optional(),
    /** Sender address. Without a verified domain Resend only delivers from onboarding@resend.dev to your own inbox. */
    EMAIL_FROM: z.string().default("BookMeBot <onboarding@resend.dev>"),
    /** PostHog (free tier). */
    POSTHOG_KEY: z.string().min(1).optional(),
    POSTHOG_HOST: z.string().url().default("https://eu.i.posthog.com"),
  },
  client: {},
  runtimeEnv: {
    NODE_ENV: process.env.NODE_ENV,
    DATABASE_URL: process.env.DATABASE_URL,
    DIRECT_URL: process.env.DIRECT_URL,
    CRON_SECRET: process.env.CRON_SECRET,
    WEBHOOK_SIMULATOR_SECRET: process.env.WEBHOOK_SIMULATOR_SECRET,
    AUTH_SECRET: process.env.AUTH_SECRET,
    WHATSAPP_APP_SECRET: process.env.WHATSAPP_APP_SECRET,
    WHATSAPP_VERIFY_TOKEN: process.env.WHATSAPP_VERIFY_TOKEN,
    WHATSAPP_ACCESS_TOKEN: process.env.WHATSAPP_ACCESS_TOKEN,
    WHATSAPP_GRAPH_VERSION: process.env.WHATSAPP_GRAPH_VERSION,
    LLM_PROVIDER: process.env.LLM_PROVIDER,
    LLM_MODEL: process.env.LLM_MODEL,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    LLM_BASE_URL: process.env.LLM_BASE_URL,
    LLM_API_KEY: process.env.LLM_API_KEY,
    STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
    STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET,
    APP_URL: process.env.APP_URL,
    GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
    SENTRY_DSN: process.env.SENTRY_DSN,
    RESEND_API_KEY: process.env.RESEND_API_KEY,
    EMAIL_FROM: process.env.EMAIL_FROM,
    POSTHOG_KEY: process.env.POSTHOG_KEY,
    POSTHOG_HOST: process.env.POSTHOG_HOST,
  },
  emptyStringAsUndefined: true,
  skipValidation: process.env.SKIP_ENV_VALIDATION === "1",
});
