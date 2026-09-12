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
  },
  emptyStringAsUndefined: true,
  skipValidation: process.env.SKIP_ENV_VALIDATION === "1",
});
