import type { BookingSource, BookingStatus, Prisma } from "@/generated/prisma/client";
import { prisma } from "@/server/db/prisma";
import { type AvailabilityConfig, workingWindows } from "./availability";
import {
  BookingStateError,
  NotFoundError,
  SlotTakenError,
  SlotUnavailableError,
  type UnavailableReason,
  VersionConflictError,
  exclusionViolation,
} from "./errors";
import {
  type Slot,
  type SlotQuery,
  type StaffCandidate,
  appointment,
  checkSlot,
  footprint,
  generateSlots,
  pickResource,
} from "./slots";
import { type Interval, type LocalDate, addDays, localDayWindow, toLocalDate } from "./time";

/**
 * The scheduling engine: the only module that writes bookings.
 *
 * Reads (getAvailability) are plain queries. Writes (reserve, reschedule)
 * run in one transaction that first takes a per-business advisory lock, so
 * check-then-insert is serialised and cannot race. The exclusion constraints
 * from migration 0 remain as the last line of defence. See ADR-002.
 */

type Db = Prisma.TransactionClient;

const ACTIVE: BookingStatus[] = ["PENDING", "CONFIRMED"];
const DAY_MS = 86_400_000;
const MIN_MS = 60_000;

// ---------------------------------------------------------------------------
// Context: everything the pure layer needs, loaded in a handful of queries
// ---------------------------------------------------------------------------

interface Context {
  business: {
    id: string;
    timezone: string;
    slotGranularityMin: number;
    minLeadMin: number;
    maxAdvanceDays: number;
  };
  service: {
    id: string;
    durationMin: number;
    bufferBeforeMin: number;
    bufferAfterMin: number;
    requiredResourceType: string | null;
  };
  /** Active staff who can perform the service, in a stable order. */
  staff: { id: string; name: string }[];
  availability: AvailabilityConfig;
  /** Active bookings of the whole business overlapping the range. */
  bookings: {
    id: string;
    staffId: string;
    startsAt: Date;
    endsAt: Date;
    service: { bufferBeforeMin: number; bufferAfterMin: number };
    resources: { resourceId: string }[];
  }[];
  /** Active resources of the required type (empty when none is required). */
  resources: { id: string }[];
}

async function loadContext(
  db: Db,
  args: {
    businessId: string;
    serviceId: string;
    staffId?: string;
    range: Interval;
    excludeBookingId?: string;
  },
): Promise<Context> {
  const business = await db.business.findUnique({
    where: { id: args.businessId },
    select: {
      id: true,
      timezone: true,
      slotGranularityMin: true,
      minLeadMin: true,
      maxAdvanceDays: true,
    },
  });
  if (!business) throw new NotFoundError("business", args.businessId);

  const service = await db.service.findFirst({
    where: { id: args.serviceId, businessId: business.id, active: true },
    select: {
      id: true,
      durationMin: true,
      bufferBeforeMin: true,
      bufferAfterMin: true,
      requiredResourceType: true,
      staff: {
        where: { staff: { active: true, ...(args.staffId ? { id: args.staffId } : {}) } },
        select: { staff: { select: { id: true, name: true } } },
      },
    },
  });
  if (!service) throw new NotFoundError("service", args.serviceId);

  const staff = service.staff
    .map((s) => s.staff)
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const staffIds = staff.map((s) => s.id);

  const [rules, overrides, bookings, resources] = await Promise.all([
    db.availabilityRule.findMany({
      where: { businessId: business.id, OR: [{ staffId: null }, { staffId: { in: staffIds } }] },
      select: { staffId: true, weekday: true, startMin: true, endMin: true },
    }),
    db.availabilityOverride.findMany({
      where: {
        businessId: business.id,
        OR: [{ staffId: null }, { staffId: { in: staffIds } }],
        date: {
          gte: new Date(toLocalDate(args.range.start, business.timezone)),
          lte: new Date(toLocalDate(args.range.end, business.timezone)),
        },
      },
      select: { staffId: true, date: true, closed: true, startMin: true, endMin: true },
    }),
    db.booking.findMany({
      where: {
        businessId: business.id,
        status: { in: ACTIVE },
        startsAt: { lt: args.range.end },
        endsAt: { gt: args.range.start },
        ...(args.excludeBookingId ? { id: { not: args.excludeBookingId } } : {}),
      },
      select: {
        id: true,
        staffId: true,
        startsAt: true,
        endsAt: true,
        service: { select: { bufferBeforeMin: true, bufferAfterMin: true } },
        resources: { select: { resourceId: true } },
      },
    }),
    service.requiredResourceType
      ? db.resource.findMany({
          where: { businessId: business.id, type: service.requiredResourceType, active: true },
          select: { id: true },
          orderBy: { name: "asc" },
        })
      : Promise.resolve([]),
  ]);

  return {
    business,
    service,
    staff,
    availability: {
      timezone: business.timezone,
      rules,
      overrides: overrides.map((o) => ({
        ...o,
        // @db.Date comes back as a Date at UTC midnight; keep only the calendar part.
        date: o.date.toISOString().slice(0, 10) as LocalDate,
      })),
    },
    bookings,
    resources,
  };
}

/** Footprint of an existing booking: its appointment plus its own service's buffers. */
function bookingFootprint(b: Context["bookings"][number]): Interval {
  return footprint({ start: b.startsAt, end: b.endsAt }, b.service);
}

/** Turn a context into the pure layer's query for the given local dates. */
function buildQuery(ctx: Context, dates: LocalDate[], now: Date): SlotQuery {
  const staff: StaffCandidate[] = ctx.staff.map((s) => ({
    staffId: s.id,
    windows: dates.flatMap((d) => workingWindows(ctx.availability, s.id, d)),
    busy: ctx.bookings.filter((b) => b.staffId === s.id).map(bookingFootprint),
  }));
  const resources = ctx.resources.map((r) => ({
    resourceId: r.id,
    busy: ctx.bookings
      .filter((b) => b.resources.some((x) => x.resourceId === r.id))
      .map(bookingFootprint),
  }));
  return {
    service: {
      durationMin: ctx.service.durationMin,
      bufferBeforeMin: ctx.service.bufferBeforeMin,
      bufferAfterMin: ctx.service.bufferAfterMin,
      requiresResource: ctx.service.requiredResourceType !== null,
    },
    staff,
    resources,
    granularityMin: ctx.business.slotGranularityMin,
    earliestStart: new Date(now.getTime() + ctx.business.minLeadMin * MIN_MS),
    latestStart: new Date(now.getTime() + ctx.business.maxAdvanceDays * DAY_MS),
  };
}

/** Local dates from `from` to `to` inclusive. */
function dateRange(from: LocalDate, to: LocalDate): LocalDate[] {
  const out: LocalDate[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/** UTC span covering the local dates plus a day of slack on each side for
 *  bookings whose footprints spill across midnight. */
function loadRange(from: LocalDate, to: LocalDate, timezone: string): Interval {
  return {
    start: new Date(localDayWindow(from, timezone).start.getTime() - DAY_MS),
    end: new Date(localDayWindow(to, timezone).end.getTime() + DAY_MS),
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export interface AvailabilityInput {
  businessId: string;
  serviceId: string;
  /** Restrict to one staff member. Omit for "any available staff". */
  staffId?: string;
  from: LocalDate;
  to: LocalDate;
  now?: Date;
}

const MAX_RANGE_DAYS = 31;

/** Bookable slots for a service between two local dates (inclusive). */
export async function getAvailability(input: AvailabilityInput, db: Db = prisma): Promise<Slot[]> {
  const now = input.now ?? new Date();
  const dates = dateRange(input.from, input.to).slice(0, MAX_RANGE_DAYS);
  if (dates.length === 0) return [];
  const timezone = (
    await db.business.findUnique({
      where: { id: input.businessId },
      select: { timezone: true },
    })
  )?.timezone;
  if (!timezone) throw new NotFoundError("business", input.businessId);

  const ctx = await loadContext(db, {
    businessId: input.businessId,
    serviceId: input.serviceId,
    staffId: input.staffId,
    range: loadRange(dates[0], dates[dates.length - 1], timezone),
  });
  return generateSlots(buildQuery(ctx, dates, now));
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

const TX_OPTS = { maxWait: 10_000, timeout: 15_000 };

/** Serialise all booking writes for one business for the rest of the transaction. */
async function lockBusiness(tx: Db, businessId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('bookings'), hashtext(${businessId}))`;
}

/**
 * Pick a staff member for `start`. Given staff: must be free. Any staff: the
 * free one with the fewest bookings in the loaded range (greedy balancing),
 * ties broken by the stable name order from loadContext.
 */
function chooseStaff(
  q: SlotQuery,
  start: Date,
  staffId: string | undefined,
): { staffId: string } | { reason: UnavailableReason } {
  const candidates = staffId ? q.staff.filter((s) => s.staffId === staffId) : q.staff;
  if (candidates.length === 0) return { reason: "STAFF_NOT_ELIGIBLE" };

  const reasons: UnavailableReason[] = [];
  let best: StaffCandidate | undefined;
  for (const s of candidates) {
    const check = checkSlot(q, s, start);
    if (!check.ok) {
      reasons.push(check.reason);
      continue;
    }
    if (!best || s.busy.length < best.busy.length) best = s;
  }
  if (best) return { staffId: best.staffId };
  // Report the most specific failure: "full" beats "closed" beats "too soon".
  const order: UnavailableReason[] = [
    "NO_RESOURCE",
    "STAFF_BUSY",
    "NOT_ON_GRID",
    "OUTSIDE_HOURS",
    "TOO_SOON",
    "TOO_FAR",
    "STAFF_NOT_ELIGIBLE",
  ];
  return { reason: order.find((r) => reasons.includes(r)) ?? reasons[0] };
}

const bookingSelect = {
  id: true,
  businessId: true,
  customerId: true,
  serviceId: true,
  staffId: true,
  status: true,
  source: true,
  startsAt: true,
  endsAt: true,
  holdExpiresAt: true,
  notes: true,
  version: true,
  cancelledAt: true,
  createdAt: true,
  updatedAt: true,
  resources: { select: { resourceId: true } },
} satisfies Prisma.BookingSelect;

export type BookingRecord = Prisma.BookingGetPayload<{ select: typeof bookingSelect }>;

export interface ReserveInput {
  businessId: string;
  serviceId: string;
  customerId: string;
  startsAt: Date;
  /** Omit for "any available staff". */
  staffId?: string;
  source?: BookingSource;
  /** PENDING holds the slot until `holdMinutes` pass (deposit flow). */
  status?: "CONFIRMED" | "PENDING";
  holdMinutes?: number;
  notes?: string;
  now?: Date;
}

/**
 * Reserve a slot. Exactly one of N concurrent calls for the same slot wins;
 * the others get SlotUnavailableError (they re-check after the winner
 * commits) or, if something bypassed the lock, SlotTakenError from the DB.
 */
export async function reserveSlot(input: ReserveInput): Promise<BookingRecord> {
  const now = input.now ?? new Date();
  return prisma.$transaction(async (tx) => {
    await lockBusiness(tx, input.businessId);

    const customer = await tx.customer.findFirst({
      where: { id: input.customerId, businessId: input.businessId },
      select: { id: true },
    });
    if (!customer) throw new NotFoundError("customer", input.customerId);

    const { ctx, q, staffId, resourceId } = await resolveSlot(tx, {
      businessId: input.businessId,
      serviceId: input.serviceId,
      staffId: input.staffId,
      startsAt: input.startsAt,
      now,
    });

    try {
      return await tx.booking.create({
        data: {
          businessId: ctx.business.id,
          customerId: customer.id,
          serviceId: ctx.service.id,
          staffId,
          status: input.status ?? "CONFIRMED",
          source: input.source ?? "API",
          startsAt: input.startsAt,
          endsAt: appointment(input.startsAt, q.service).end,
          holdExpiresAt:
            input.status === "PENDING"
              ? new Date(now.getTime() + (input.holdMinutes ?? 10) * MIN_MS)
              : null,
          notes: input.notes,
          // startsAt/endsAt on the mirror row are overwritten by the trigger.
          resources: resourceId
            ? { create: { resourceId, startsAt: input.startsAt, endsAt: input.startsAt } }
            : undefined,
        },
        select: bookingSelect,
      });
    } catch (err) {
      const constraint = exclusionViolation(err);
      if (constraint) throw new SlotTakenError(constraint);
      throw err;
    }
  }, TX_OPTS);
}

/**
 * Shared by reserve and reschedule: load the day, run the same check the
 * generator uses, and pick staff + resource. Throws SlotUnavailableError.
 */
async function resolveSlot(
  tx: Db,
  args: {
    businessId: string;
    serviceId: string;
    staffId?: string;
    startsAt: Date;
    now: Date;
    excludeBookingId?: string;
  },
) {
  const business = await tx.business.findUnique({
    where: { id: args.businessId },
    select: { timezone: true },
  });
  if (!business) throw new NotFoundError("business", args.businessId);

  const date = toLocalDate(args.startsAt, business.timezone);
  const ctx = await loadContext(tx, {
    businessId: args.businessId,
    serviceId: args.serviceId,
    staffId: args.staffId,
    range: loadRange(date, date, business.timezone),
    excludeBookingId: args.excludeBookingId,
  });
  // A late-evening slot may belong to a window that started the day before
  // in UTC terms, so evaluate the neighbouring dates too.
  const q = buildQuery(ctx, [addDays(date, -1), date, addDays(date, 1)], args.now);

  const chosen = chooseStaff(q, args.startsAt, args.staffId);
  if ("reason" in chosen) throw new SlotUnavailableError(chosen.reason, args.startsAt);

  const fp = footprint(appointment(args.startsAt, q.service), q.service);
  const resourceId = q.service.requiresResource ? pickResource(q.resources, fp) : null;
  if (q.service.requiresResource && !resourceId) {
    throw new SlotUnavailableError("NO_RESOURCE", args.startsAt);
  }
  return { ctx, q, staffId: chosen.staffId, resourceId };
}

export interface CancelInput {
  businessId: string;
  bookingId: string;
  expectedVersion?: number;
  now?: Date;
}

/**
 * Cancel a booking, releasing its staff and resource ranges (the trigger
 * flips the mirror rows to inactive). Idempotent on an already-cancelled
 * booking; refuses to touch completed / no-show ones.
 */
export async function cancelBooking(input: CancelInput): Promise<BookingRecord> {
  return prisma.$transaction(async (tx) => {
    const booking = await tx.booking.findFirst({
      where: { id: input.bookingId, businessId: input.businessId },
      select: bookingSelect,
    });
    if (!booking) throw new NotFoundError("booking", input.bookingId);
    if (booking.status === "CANCELLED") return booking;
    if (!ACTIVE.includes(booking.status)) {
      throw new BookingStateError(booking.id, booking.status, "cancel");
    }
    if (input.expectedVersion !== undefined && input.expectedVersion !== booking.version) {
      throw new VersionConflictError(booking.id, input.expectedVersion, booking.version);
    }
    return tx.booking.update({
      where: { id: booking.id },
      data: {
        status: "CANCELLED",
        cancelledAt: input.now ?? new Date(),
        version: { increment: 1 },
      },
      select: bookingSelect,
    });
  }, TX_OPTS);
}

export interface RescheduleInput {
  businessId: string;
  bookingId: string;
  startsAt: Date;
  /** Keep the current staff member unless given. Pass "any" to let the engine choose. */
  staffId?: string | "any";
  expectedVersion?: number;
  now?: Date;
}

/**
 * Move a booking to a new slot atomically: either the booking ends up at the
 * new time with a (possibly new) resource, or nothing changes. The booking's
 * own current slot is excluded from the busy set, so moving by 15 minutes
 * into its own footprint works.
 */
export async function rescheduleBooking(input: RescheduleInput): Promise<BookingRecord> {
  const now = input.now ?? new Date();
  return prisma.$transaction(async (tx) => {
    await lockBusiness(tx, input.businessId);

    const booking = await tx.booking.findFirst({
      where: { id: input.bookingId, businessId: input.businessId },
      select: bookingSelect,
    });
    if (!booking) throw new NotFoundError("booking", input.bookingId);
    if (!ACTIVE.includes(booking.status)) {
      throw new BookingStateError(booking.id, booking.status, "reschedule");
    }
    if (input.expectedVersion !== undefined && input.expectedVersion !== booking.version) {
      throw new VersionConflictError(booking.id, input.expectedVersion, booking.version);
    }

    const { q, staffId, resourceId } = await resolveSlot(tx, {
      businessId: input.businessId,
      serviceId: booking.serviceId,
      staffId: input.staffId === "any" ? undefined : (input.staffId ?? booking.staffId),
      startsAt: input.startsAt,
      now,
      excludeBookingId: booking.id,
    });

    try {
      // Drop the old resource mirror first: updating the booking fires the
      // sync trigger, which would otherwise move the old resource's range
      // and could collide before we get to swap resources.
      await tx.bookingResource.deleteMany({ where: { bookingId: booking.id } });
      return await tx.booking.update({
        where: { id: booking.id },
        data: {
          staffId,
          startsAt: input.startsAt,
          endsAt: appointment(input.startsAt, q.service).end,
          version: { increment: 1 },
          resources: resourceId
            ? { create: { resourceId, startsAt: input.startsAt, endsAt: input.startsAt } }
            : undefined,
        },
        select: bookingSelect,
      });
    } catch (err) {
      const constraint = exclusionViolation(err);
      if (constraint) throw new SlotTakenError(constraint);
      throw err;
    }
  }, TX_OPTS);
}

/**
 * Release PENDING holds whose deadline passed. Meant for a cron route; the
 * DB treats PENDING as occupied until this runs, so the sweep interval bounds
 * how long an abandoned checkout blocks a slot.
 */
export async function releaseExpiredHolds(now: Date = new Date()): Promise<number> {
  const result = await prisma.booking.updateMany({
    where: { status: "PENDING", holdExpiresAt: { lt: now } },
    data: { status: "CANCELLED", cancelledAt: now, version: { increment: 1 } },
  });
  return result.count;
}
