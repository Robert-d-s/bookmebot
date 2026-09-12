import { TZDate } from "@date-fns/tz";

/**
 * Time helpers for the scheduling engine.
 *
 * Rule: instants are UTC `Date`s everywhere; "minutes from local midnight" and
 * "local calendar date" only exist at the edges. These helpers are the edges.
 */

/** A closed-open interval [start, end) of UTC instants. */
export interface Interval {
  start: Date;
  end: Date;
}

/** Local calendar date as "YYYY-MM-DD". */
export type LocalDate = `${number}-${number}-${number}`;

/**
 * Convert minutes-from-local-midnight on a given local date to a UTC instant.
 *
 * Uses TZDate so DST is handled by the platform's IANA data: on the spring
 * forward day 02:30 local does not exist and resolves to 03:30; on the fall
 * back day ambiguous times resolve to the first occurrence.
 */
export function localMinutesToUtc(date: LocalDate, minutes: number, timezone: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  const local = new TZDate(y, m - 1, d, hours, mins, 0, 0, timezone);
  return new Date(local.getTime());
}

/** The [start, end) window covering a whole local calendar day, in UTC. */
export function localDayWindow(date: LocalDate, timezone: string): Interval {
  return {
    start: localMinutesToUtc(date, 0, timezone),
    end: localMinutesToUtc(addDays(date, 1), 0, timezone),
  };
}

/** Local calendar date of a UTC instant in the given zone. */
export function toLocalDate(instant: Date, timezone: string): LocalDate {
  const z = new TZDate(instant.getTime(), timezone);
  const y = z.getFullYear();
  const m = String(z.getMonth() + 1).padStart(2, "0");
  const d = String(z.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}` as LocalDate;
}

/** JS weekday (0 = Sunday) of a local calendar date. */
export function localWeekday(date: LocalDate, timezone: string): number {
  return new TZDate(localMinutesToUtc(date, 12 * 60, timezone).getTime(), timezone).getDay();
}

/** Add whole days to a local calendar date. Pure calendar arithmetic, no zones. */
export function addDays(date: LocalDate, days: number): LocalDate {
  const [y, m, d] = date.split("-").map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + days));
  const yy = next.getUTCFullYear();
  const mm = String(next.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(next.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}` as LocalDate;
}

/** True when two closed-open intervals share any instant. */
export function overlaps(a: Interval, b: Interval): boolean {
  return a.start < b.end && b.start < a.end;
}
