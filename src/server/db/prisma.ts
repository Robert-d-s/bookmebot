import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { env } from "@/env";

/**
 * Single PrismaClient for the process.
 *
 * Prisma 7 talks to Postgres through a driver adapter (node-postgres here).
 * On Vercel each function instance is a separate process, so the pool is
 * kept tiny (`connection_limit=1` in DATABASE_URL on Supabase) and the
 * transaction pooler multiplexes real connections behind it.
 *
 * In development Next.js hot-reloads modules; caching the client on
 * globalThis avoids opening a new pool on every reload.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

function createClient() {
  const adapter = new PrismaPg({ connectionString: env.DATABASE_URL });
  return new PrismaClient({
    adapter,
    log: env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });
}

export const prisma = globalForPrisma.prisma ?? createClient();

if (env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
