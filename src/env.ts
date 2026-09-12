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
  },
  client: {},
  runtimeEnv: {
    NODE_ENV: process.env.NODE_ENV,
    DATABASE_URL: process.env.DATABASE_URL,
    DIRECT_URL: process.env.DIRECT_URL,
    CRON_SECRET: process.env.CRON_SECRET,
    WEBHOOK_SIMULATOR_SECRET: process.env.WEBHOOK_SIMULATOR_SECRET,
  },
  emptyStringAsUndefined: true,
  skipValidation: process.env.SKIP_ENV_VALIDATION === "1",
});
