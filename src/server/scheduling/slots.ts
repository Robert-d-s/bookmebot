import type { UnavailableReason } from "./errors";
import { type Interval, overlaps } from "./time";

/**
 * Slot generation and the single availability predicate.
 *
 * The same `checkSlot` decides both what the generator offers and what the
 * reserve transaction accepts, so a slot that was shown can always be booked
 * (barring a race, which the DB constraint settles) and a slot that was not
 * shown is never accepted.
 *
 * Pure: no clock, no database. Busy intervals are passed in already expanded
 * to their footprint (appointment plus that service's buffers).
 */

export interface ServiceSpec {
  durationMin: number;
  bufferBeforeMin: number;
  bufferAfterMin: number;
  /** When set, a booking also needs one free resource from `resources`. */
  requiresResource: boolean;
}

export interface StaffCandidate {
  staffId: string;
  /** Working windows for the day(s) in question. */
  windows: Interval[];
  /** Footprints of this staff member's active bookings. */
  busy: Interval[];
}

export interface ResourceCandidate {
  resourceId: string;
  /** Footprints of active bookings occupying this resource. */
  busy: Interval[];
}

export interface SlotQuery {
  service: ServiceSpec;
  staff: StaffCandidate[];
  /** Resources of the service's required type. Ignored when none is required. */
  resources: ResourceCandidate[];
  granularityMin: number;
  /** Earliest acceptable start (now + lead time). */
  earliestStart: Date;
  /** Latest acceptable start (now + max advance). */
  latestStart: Date;
}

export interface Slot {
  start: Date;
  end: Date;
  /** Every eligible staff member who could take this slot. */
  staffIds: string[];
}

const MS = 60_000;

/** Appointment interval for a start time. */
export function appointment(start: Date, service: ServiceSpec): Interval {
  return { start, end: new Date(start.getTime() + service.durationMin * MS) };
}

/** Appointment plus buffers: the time the staff member and resource are actually tied up. */
export function footprint(
  interval: Interval,
  service: Pick<ServiceSpec, "bufferBeforeMin" | "bufferAfterMin">,
): Interval {
  return {
    start: new Date(interval.start.getTime() - service.bufferBeforeMin * MS),
    end: new Date(interval.end.getTime() + service.bufferAfterMin * MS),
  };
}

export type SlotCheck = { ok: true } | { ok: false; reason: UnavailableReason };

/** Can `staff` take `service` starting at `start`? */
export function checkSlot(q: SlotQuery, staff: StaffCandidate, start: Date): SlotCheck {
  if (start < q.earliestStart) return { ok: false, reason: "TOO_SOON" };
  if (start > q.latestStart) return { ok: false, reason: "TOO_FAR" };

  const appt = appointment(start, q.service);
  const window = staff.windows.find((w) => w.start <= appt.start && appt.end <= w.end);
  if (!window) return { ok: false, reason: "OUTSIDE_HOURS" };
  // Grid is anchored at the opening time of the window the slot falls in, so
  // 09:00, 09:15, ... regardless of DST or the window's UTC offset.
  if ((appt.start.getTime() - window.start.getTime()) % (q.granularityMin * MS) !== 0) {
    return { ok: false, reason: "NOT_ON_GRID" };
  }

  const fp = footprint(appt, q.service);
  if (staff.busy.some((b) => overlaps(b, fp))) return { ok: false, reason: "STAFF_BUSY" };
  if (q.service.requiresResource && pickResource(q.resources, fp) === null) {
    return { ok: false, reason: "NO_RESOURCE" };
  }
  return { ok: true };
}

/** First resource free for the whole footprint, or null. Greedy on purpose. */
export function pickResource(resources: ResourceCandidate[], fp: Interval): string | null {
  return resources.find((r) => !r.busy.some((b) => overlaps(b, fp)))?.resourceId ?? null;
}

/**
 * Every bookable slot, merged across staff and sorted by start.
 * Candidates are the grid points of each working window; `checkSlot` filters.
 */
export function generateSlots(q: SlotQuery): Slot[] {
  const byStart = new Map<number, Slot>();
  const step = q.granularityMin * MS;
  for (const staff of q.staff) {
    for (const w of staff.windows) {
      for (
        let t = w.start.getTime();
        t + q.service.durationMin * MS <= w.end.getTime();
        t += step
      ) {
        const start = new Date(t);
        if (!checkSlot(q, staff, start).ok) continue;
        const slot = byStart.get(t) ?? { ...appointment(start, q.service), staffIds: [] };
        slot.staffIds.push(staff.staffId);
        byStart.set(t, slot);
      }
    }
  }
  return [...byStart.values()].sort((a, b) => a.start.getTime() - b.start.getTime());
}
