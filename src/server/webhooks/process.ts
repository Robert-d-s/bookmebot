import type { InboundEvent, InboundEventStatus, Prisma } from "@/generated/prisma/client";
import { prisma } from "@/server/db/prisma";
import { getHandler } from "./registry";
import type { HandlerOutcome } from "./types";

/**
 * Step 2 of the pipeline: claim an event, run its handler, record the outcome.
 *
 * Safe to call from several places at once (the route right after ingest,
 * the cron sweeper, an admin replay): the claim is an UPDATE guarded by the
 * current status, so only one caller ever runs the handler for an event.
 */

export const MAX_ATTEMPTS = 5;
const BASE_DELAY_MS = 60_000;
const MAX_DELAY_MS = 60 * 60_000;

/** 1m, 2m, 4m, 8m, 16m ... capped at 1h, with up to 20% jitter so retries spread out. */
export function backoffMs(attempt: number, random: () => number = Math.random): number {
  const exp = Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), MAX_DELAY_MS);
  return Math.round(exp * (1 + 0.2 * random()));
}

const CLAIMABLE: InboundEventStatus[] = ["RECEIVED", "FAILED", "DEFERRED"];

export interface ProcessOptions {
  now?: Date;
  /** Injected for deterministic backoff in tests. */
  random?: () => number;
}

/**
 * Process one event by id. Returns the outcome, or null when the event was
 * not claimable (already processed, dead, or being handled by someone else).
 */
export async function processEvent(
  eventId: string,
  opts: ProcessOptions = {},
): Promise<HandlerOutcome | null> {
  const now = opts.now ?? new Date();

  const claimed = await prisma.inboundEvent.updateMany({
    where: { id: eventId, status: { in: CLAIMABLE } },
    data: { status: "PROCESSING", attempts: { increment: 1 } },
  });
  if (claimed.count === 0) return null;

  const event = await prisma.inboundEvent.findUniqueOrThrow({ where: { id: eventId } });
  const handler = getHandler(event.provider);

  let outcome: HandlerOutcome;
  if (!handler) {
    outcome = { kind: "reject", reason: `no handler for provider ${event.provider}` };
  } else {
    try {
      outcome = await handler(event);
    } catch (err) {
      outcome = { kind: "retry", reason: err instanceof Error ? err.message : String(err) };
    }
  }

  await record(event, outcome, now, opts.random);

  if (outcome.kind === "processed" && event.correlationKey) {
    await requeueDeferredSiblings(event, now, opts);
  }
  return outcome;
}

async function record(
  event: InboundEvent,
  outcome: HandlerOutcome,
  now: Date,
  random?: () => number,
) {
  const data: Prisma.InboundEventUpdateInput = (() => {
    switch (outcome.kind) {
      case "processed":
        return {
          status: "PROCESSED",
          processedAt: now,
          lastError: null,
          nextAttemptAt: null,
          result: (outcome.result ?? null) as Prisma.InputJsonValue,
        };
      case "skipped":
        return {
          status: "SKIPPED",
          processedAt: now,
          lastError: outcome.reason,
          nextAttemptAt: null,
        };
      case "reject":
        return { status: "DEAD", lastError: outcome.reason, nextAttemptAt: null };
      case "retry":
      case "defer": {
        const exhausted = event.attempts >= MAX_ATTEMPTS;
        return {
          status: exhausted ? "DEAD" : outcome.kind === "defer" ? "DEFERRED" : "FAILED",
          lastError: outcome.reason,
          nextAttemptAt: exhausted
            ? null
            : new Date(now.getTime() + backoffMs(event.attempts, random)),
        };
      }
    }
  })();
  await prisma.inboundEvent.update({ where: { id: event.id }, data });
}

/**
 * Out-of-order handling: when an event lands, any sibling that was deferred
 * waiting for it gets run again right now instead of at its backoff time.
 */
async function requeueDeferredSiblings(event: InboundEvent, now: Date, opts: ProcessOptions) {
  const siblings = await prisma.inboundEvent.findMany({
    where: {
      provider: event.provider,
      correlationKey: event.correlationKey,
      status: "DEFERRED",
      id: { not: event.id },
    },
    select: { id: true },
    orderBy: { receivedAt: "asc" },
  });
  for (const s of siblings) await processEvent(s.id, { ...opts, now });
}

/**
 * The sweeper: run everything that is due. Called by the cron route. Each
 * event is claimed individually, so overlapping sweeps do not double-run.
 */
export async function processDue(opts: ProcessOptions & { limit?: number } = {}): Promise<{
  attempted: number;
  outcomes: Record<HandlerOutcome["kind"], number>;
}> {
  const now = opts.now ?? new Date();
  const due = await prisma.inboundEvent.findMany({
    where: {
      OR: [
        { status: "RECEIVED" },
        { status: { in: ["FAILED", "DEFERRED"] }, nextAttemptAt: { lte: now } },
      ],
    },
    select: { id: true },
    orderBy: { receivedAt: "asc" },
    take: opts.limit ?? 50,
  });
  const outcomes = { processed: 0, skipped: 0, retry: 0, defer: 0, reject: 0 };
  let attempted = 0;
  for (const { id } of due) {
    const outcome = await processEvent(id, opts);
    if (!outcome) continue;
    attempted += 1;
    outcomes[outcome.kind] += 1;
  }
  return { attempted, outcomes };
}

/** Put a dead (or any non-running) event back in the queue and run it now. */
export async function replayEvent(eventId: string, opts: ProcessOptions = {}) {
  const reset = await prisma.inboundEvent.updateMany({
    where: { id: eventId, status: { not: "PROCESSING" } },
    data: { status: "RECEIVED", attempts: 0, nextAttemptAt: null, lastError: null },
  });
  if (reset.count === 0) return null;
  return processEvent(eventId, opts);
}

/** Dead-letter (or any status) listing for the admin route and, later, the dashboard. */
export async function listEvents(filter: {
  status?: InboundEventStatus;
  provider?: string;
  limit?: number;
}) {
  return prisma.inboundEvent.findMany({
    where: { status: filter.status, provider: filter.provider },
    orderBy: { receivedAt: "desc" },
    take: filter.limit ?? 50,
    select: {
      id: true,
      provider: true,
      providerEventId: true,
      eventType: true,
      correlationKey: true,
      status: true,
      attempts: true,
      nextAttemptAt: true,
      lastError: true,
      result: true,
      receivedAt: true,
      processedAt: true,
    },
  });
}
