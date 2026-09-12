import { describe, expect, it } from "vitest";
import {
  addDays,
  localDayWindow,
  localMinutesToUtc,
  localWeekday,
  overlaps,
  toLocalDate,
} from "@/server/scheduling/time";

const TZ = "Europe/Bucharest";

describe("localMinutesToUtc", () => {
  it("converts winter local time (UTC+2)", () => {
    expect(localMinutesToUtc("2026-01-15", 9 * 60, TZ).toISOString()).toBe(
      "2026-01-15T07:00:00.000Z",
    );
  });

  it("converts summer local time (UTC+3)", () => {
    expect(localMinutesToUtc("2026-07-15", 9 * 60, TZ).toISOString()).toBe(
      "2026-07-15T06:00:00.000Z",
    );
  });

  it("handles the spring-forward day: the day is 23 hours long", () => {
    // Romania moves clocks forward on the last Sunday of March.
    const w = localDayWindow("2026-03-29", TZ);
    expect((w.end.getTime() - w.start.getTime()) / 3_600_000).toBe(23);
  });

  it("handles the fall-back day: the day is 25 hours long", () => {
    const w = localDayWindow("2026-10-25", TZ);
    expect((w.end.getTime() - w.start.getTime()) / 3_600_000).toBe(25);
  });
});

describe("calendar helpers", () => {
  it("addDays crosses month and year boundaries", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("toLocalDate respects the zone near midnight", () => {
    // 22:30Z on Jan 15 is 00:30 on Jan 16 in Bucharest.
    expect(toLocalDate(new Date("2026-01-15T22:30:00Z"), TZ)).toBe("2026-01-16");
  });

  it("localWeekday uses JS convention (0 = Sunday)", () => {
    expect(localWeekday("2026-09-13", TZ)).toBe(0);
    expect(localWeekday("2026-09-14", TZ)).toBe(1);
  });
});

describe("overlaps", () => {
  const at = (h: number) => new Date(Date.UTC(2026, 0, 1, h));
  it("is true for partial overlap and containment", () => {
    expect(overlaps({ start: at(9), end: at(10) }, { start: at(9), end: at(11) })).toBe(true);
    expect(overlaps({ start: at(9), end: at(12) }, { start: at(10), end: at(11) })).toBe(true);
  });
  it("is false for touching intervals (closed-open)", () => {
    expect(overlaps({ start: at(9), end: at(10) }, { start: at(10), end: at(11) })).toBe(false);
  });
});
