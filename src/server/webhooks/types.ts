import type { InboundEvent } from "@/generated/prisma/client";

/**
 * Contracts for the inbound webhook layer.
 *
 * A Provider knows how one external system signs and shapes its deliveries.
 * A Handler knows what to do with one event of that provider. The layer in
 * between (ingest, process) is provider-agnostic and is built once.
 */

/** One logical event extracted from a delivery. */
export interface ParsedEvent {
  /** Provider's own id for the event; the dedupe key. */
  providerEventId: string;
  eventType: string;
  /** Optional grouping key for out-of-order reconciliation. */
  correlationKey?: string;
  payload: unknown;
}

export interface WebhookProvider {
  name: string;
  /** Verify the delivery's signature against the raw body. Never throws. */
  verify(rawBody: string, headers: Headers): boolean;
  /**
   * Split a raw body into events. May throw on malformed JSON; the delivery
   * is still persisted and the error reported as 400.
   */
  parse(rawBody: string): ParsedEvent[];
  /** Some providers (Meta) verify the endpoint with a GET challenge. */
  challenge?(url: URL): Response | null;
}

/**
 * What a handler decided.
 * - processed: done; `result` is stored for inspection and for siblings.
 * - skipped:   nothing to do, permanently (business rule said no).
 * - retry:     transient failure, try again after backoff.
 * - defer:     needs a sibling that has not arrived yet; retried like `retry`
 *              and re-run immediately when a sibling with the same
 *              correlation key is processed.
 * - reject:    poison message; dead-letter without retrying.
 * A thrown error counts as `retry` with the message as the reason.
 */
export type HandlerOutcome =
  | { kind: "processed"; result?: unknown }
  | { kind: "skipped"; reason: string }
  | { kind: "retry"; reason: string }
  | { kind: "defer"; reason: string }
  | { kind: "reject"; reason: string };

export type EventHandler = (event: InboundEvent) => Promise<HandlerOutcome>;
