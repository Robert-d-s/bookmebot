import * as Sentry from "@sentry/nextjs";
import type { Instrumentation } from "next";

/**
 * Next.js server instrumentation hook. Runs once per server process.
 * Sentry is opt-in via SENTRY_DSN (free developer tier is enough).
 */
export async function register() {
  if (!process.env.SENTRY_DSN) return;
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
    tracesSampleRate: 0.1,
    sendDefaultPii: false,
  });
}

/** Server-side errors Next catches (render, route handlers, actions) go to Sentry too. */
export const onRequestError: Instrumentation.onRequestError = (...args) => {
  if (!process.env.SENTRY_DSN) return;
  Sentry.captureRequestError(...args);
};
