import { NextResponse } from "next/server";
import { ZodError } from "zod";
import {
  BookingStateError,
  NotFoundError,
  SlotTakenError,
  SlotUnavailableError,
  VersionConflictError,
} from "@/server/scheduling/errors";

/**
 * One place that turns engine errors into HTTP. Route handlers wrap their
 * body in `handle` and throw freely.
 */
export function errorResponse(err: unknown): NextResponse {
  if (err instanceof ZodError) {
    return NextResponse.json({ error: "INVALID_INPUT", issues: err.issues }, { status: 400 });
  }
  if (err instanceof NotFoundError) {
    return NextResponse.json({ error: err.code, entity: err.entity, id: err.id }, { status: 404 });
  }
  if (err instanceof SlotUnavailableError) {
    return NextResponse.json(
      { error: err.code, reason: err.reason, startsAt: err.startsAt.toISOString() },
      { status: 409 },
    );
  }
  if (err instanceof SlotTakenError) {
    return NextResponse.json({ error: err.code, constraint: err.constraint }, { status: 409 });
  }
  if (err instanceof BookingStateError || err instanceof VersionConflictError) {
    return NextResponse.json({ error: err.code, message: err.message }, { status: 409 });
  }
  console.error(err);
  return NextResponse.json({ error: "INTERNAL" }, { status: 500 });
}

export async function handle(fn: () => Promise<NextResponse>): Promise<NextResponse> {
  try {
    return await fn();
  } catch (err) {
    return errorResponse(err);
  }
}
