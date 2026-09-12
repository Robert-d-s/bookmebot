import { PostHog } from "posthog-node";
import { env } from "@/env";

/**
 * Product analytics: a handful of server-side events. PostHog is opt-in via
 * POSTHOG_KEY (free tier). Without it, `track` is a no-op; tests inject a
 * capturing client.
 */
export interface AnalyticsClient {
  capture(e: { distinctId: string; event: string; properties?: Record<string, unknown> }): void;
  shutdown?(): Promise<void>;
}

let client: AnalyticsClient | null | undefined;
let override: AnalyticsClient | null | undefined;

function get(): AnalyticsClient | null {
  if (override !== undefined) return override;
  if (client !== undefined) return client;
  client = env.POSTHOG_KEY
    ? new PostHog(env.POSTHOG_KEY, { host: env.POSTHOG_HOST, flushAt: 1, flushInterval: 1000 })
    : null;
  return client;
}

export type AnalyticsEvent =
  "booking_created" | "booking_cancelled" | "payment_paid" | "message_received" | "handoff";

/** distinctId is the business: we measure the product, not people. */
export function track(
  businessId: string,
  event: AnalyticsEvent,
  properties: Record<string, unknown> = {},
) {
  get()?.capture({ distinctId: businessId, event, properties });
}

export function setAnalyticsClient(c: AnalyticsClient | null | undefined) {
  override = c;
}
