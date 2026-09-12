import "dotenv/config";
import { defineConfig, env } from "prisma/config";

/**
 * Prisma 7 moved connection settings out of schema.prisma and into this file.
 *
 * The URL here is used ONLY by the Prisma CLI (migrate, db seed, studio).
 * On Supabase that must be a *session-mode* connection (port 5432 on the pooler
 * host, IPv4-capable). The runtime client in src/server/db/prisma.ts uses
 * DATABASE_URL, which on Supabase is the *transaction-mode* pooler (port 6543).
 * Locally both point at the same Docker Postgres.
 */
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    url: env("DIRECT_URL"),
  },
});
