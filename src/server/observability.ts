import * as Sentry from "@sentry/nextjs";
import { env } from "@/env";

/**
 * Error reporting. Sentry is initialised in src/instrumentation.ts only when
 * SENTRY_DSN is set; these helpers are safe to call either way.
 */
export const sentryEnabled = () => Boolean(env.SENTRY_DSN);

export function reportError(err: unknown, context?: Record<string, unknown>) {
  if (!sentryEnabled()) return;
  Sentry.captureException(err, context ? { extra: context } : undefined);
}
