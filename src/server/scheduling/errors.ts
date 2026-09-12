import { Prisma } from "@/generated/prisma/client";

/**
 * Typed failures of the scheduling engine. Route handlers and the
 * conversation layer map these to HTTP statuses / customer-facing wording;
 * nothing else in the app should have to parse error messages.
 */
export abstract class SchedulingError extends Error {
  abstract readonly code: string;
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class NotFoundError extends SchedulingError {
  readonly code = "NOT_FOUND";
  constructor(
    readonly entity: string,
    readonly id: string,
  ) {
    super(`${entity} ${id} not found`);
  }
}

export type UnavailableReason =
  | "STAFF_NOT_ELIGIBLE"
  | "OUTSIDE_HOURS"
  | "TOO_SOON"
  | "TOO_FAR"
  | "NOT_ON_GRID"
  | "STAFF_BUSY"
  | "NO_RESOURCE";

/** The engine's own check said no: outside hours, too soon, staff busy, ... */
export class SlotUnavailableError extends SchedulingError {
  readonly code = "SLOT_UNAVAILABLE";
  constructor(
    readonly reason: UnavailableReason,
    readonly startsAt: Date,
  ) {
    super(`slot ${startsAt.toISOString()} unavailable: ${reason}`);
  }
}

/**
 * The database's exclusion constraint said no. With the advisory lock in
 * place this should never fire; if it does, it means two writers bypassed the
 * lock (e.g. a manual SQL insert) and the constraint did its job.
 */
export class SlotTakenError extends SchedulingError {
  readonly code = "SLOT_TAKEN";
  constructor(readonly constraint: string) {
    super(`slot already taken (${constraint})`);
  }
}

/** Operation not valid for the booking's current status. */
export class BookingStateError extends SchedulingError {
  readonly code = "BOOKING_STATE";
  constructor(
    readonly bookingId: string,
    readonly status: string,
    readonly operation: string,
  ) {
    super(`cannot ${operation} booking ${bookingId} in status ${status}`);
  }
}

/** Optimistic-concurrency check failed: someone else edited the booking. */
export class VersionConflictError extends SchedulingError {
  readonly code = "VERSION_CONFLICT";
  constructor(
    readonly bookingId: string,
    readonly expected: number,
    readonly actual: number,
  ) {
    super(`booking ${bookingId} is at version ${actual}, expected ${expected}`);
  }
}

/**
 * Prisma 7 with a driver adapter reports a Postgres exclusion violation as
 * P2039 with the original SQLSTATE (23P01) nested in meta. Returns the
 * constraint name when that is what happened, else null.
 */
export function exclusionViolation(err: unknown): string | null {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError)) return null;
  const meta = err.meta as
    { driverAdapterError?: { cause?: { code?: string; message?: string } } } | undefined;
  const cause = meta?.driverAdapterError?.cause;
  if (cause?.code !== "23P01") return null;
  return /constraint "([^"]+)"/.exec(cause.message ?? "")?.[1] ?? "unknown";
}
