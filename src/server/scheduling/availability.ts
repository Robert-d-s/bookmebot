import { type Interval, type LocalDate, localMinutesToUtc, localWeekday } from "./time";

/**
 * Opening hours: from weekly rules and one-off overrides to concrete UTC
 * windows for one staff member on one local date.
 *
 * Pure. The engine loads rows from the database and hands them in; tests build
 * them by hand.
 */

/** Weekly recurring window. staffId null = the business itself. */
export interface WeeklyRule {
  staffId: string | null;
  weekday: number;
  startMin: number;
  endMin: number;
}

/** One-off exception for a local date. Wins over weekly rules. */
export interface DateOverride {
  staffId: string | null;
  date: LocalDate;
  closed: boolean;
  startMin: number | null;
  endMin: number | null;
}

export interface AvailabilityConfig {
  timezone: string;
  rules: WeeklyRule[];
  overrides: DateOverride[];
}

/**
 * Windows in which `staffId` can take appointments on `date`.
 *
 * Resolution, for the business and for the staff member separately:
 *   1. an override for that date: closed => nothing; custom => that window
 *   2. else the weekly rules for that weekday (several = split shifts)
 * A staff member with no weekly rules at all inherits the business hours.
 * One with rules on other weekdays but none on this one is off that day.
 * The result is the intersection of the business windows and the staff
 * windows: staff can never be bookable while the business is closed.
 */
export function workingWindows(
  cfg: AvailabilityConfig,
  staffId: string,
  date: LocalDate,
): Interval[] {
  const business = windowsFor(cfg, null, date, false);
  const staffHasRules = cfg.rules.some((r) => r.staffId === staffId);
  const staff = windowsFor(cfg, staffId, date, !staffHasRules);
  return intersectAll(business, staff);
}

function windowsFor(
  cfg: AvailabilityConfig,
  staffId: string | null,
  date: LocalDate,
  wholeDayIfNoRules: boolean,
): Interval[] {
  const override = cfg.overrides.find((o) => o.staffId === staffId && o.date === date);
  if (override) {
    if (override.closed || override.startMin == null || override.endMin == null) return [];
    return [toInterval(date, override.startMin, override.endMin, cfg.timezone)];
  }
  const weekday = localWeekday(date, cfg.timezone);
  const rules = cfg.rules.filter((r) => r.staffId === staffId && r.weekday === weekday);
  if (rules.length === 0 && wholeDayIfNoRules) {
    return [toInterval(date, 0, 24 * 60, cfg.timezone)];
  }
  return normalise(rules.map((r) => toInterval(date, r.startMin, r.endMin, cfg.timezone)));
}

function toInterval(date: LocalDate, startMin: number, endMin: number, tz: string): Interval {
  return { start: localMinutesToUtc(date, startMin, tz), end: localMinutesToUtc(date, endMin, tz) };
}

/** Sort by start and merge touching/overlapping intervals. */
export function normalise(intervals: Interval[]): Interval[] {
  const sorted = intervals
    .filter((i) => i.start < i.end)
    .sort((a, b) => a.start.getTime() - b.start.getTime());
  const out: Interval[] = [];
  for (const i of sorted) {
    const last = out[out.length - 1];
    if (last && i.start <= last.end) {
      if (i.end > last.end) last.end = i.end;
    } else {
      out.push({ start: i.start, end: i.end });
    }
  }
  return out;
}

/** Instants covered by both lists. */
export function intersectAll(a: Interval[], b: Interval[]): Interval[] {
  const out: Interval[] = [];
  for (const x of a) {
    for (const y of b) {
      const start = x.start > y.start ? x.start : y.start;
      const end = x.end < y.end ? x.end : y.end;
      if (start < end) out.push({ start, end });
    }
  }
  return normalise(out);
}

/** True when `inner` lies entirely inside one of `windows`. */
export function containedIn(inner: Interval, windows: Interval[]): boolean {
  return windows.some((w) => w.start <= inner.start && inner.end <= w.end);
}
