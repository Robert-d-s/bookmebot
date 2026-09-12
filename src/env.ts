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
  },
  client: {},
  runtimeEnv: {
    NODE_ENV: process.env.NODE_ENV,
    DATABASE_URL: process.env.DATABASE_URL,
    DIRECT_URL: process.env.DIRECT_URL,
  },
  emptyStringAsUndefined: true,
  skipValidation: process.env.SKIP_ENV_VALIDATION === "1",
});
