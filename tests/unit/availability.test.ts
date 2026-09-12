import { describe, expect, it } from "vitest";
import {
  type AvailabilityConfig,
  containedIn,
  intersectAll,
  normalise,
  workingWindows,
} from "@/server/scheduling/availability";
import { localMinutesToUtc } from "@/server/scheduling/time";

const TZ = "Europe/Bucharest";
const H = (h: number, m = 0) => h * 60 + m;
const MON = "2030-01-07"; // Monday
const TUE = "2030-01-08";
const SUN = "2030-01-13";

const iso = (date: `${number}-${number}-${number}`, min: number) =>
  localMinutesToUtc(date, min, TZ).toISOString();

const base: AvailabilityConfig = {
  timezone: TZ,
  rules: [
    ...[1, 2, 3, 4, 5].map((weekday) => ({
      staffId: null,
      weekday,
      startMin: H(9),
      endMin: H(18),
    })),
    // Ioana: Tue-Fri, until 16:00. Nothing on Monday => off.
    ...[2, 3, 4, 5].map((weekday) => ({
      staffId: "ioana",
      weekday,
      startMin: H(9),
      endMin: H(16),
    })),
  ],
  overrides: [],
};

describe("workingWindows", () => {
  it("staff without own rules inherit business hours", () => {
    const w = workingWindows(base, "andrei", MON);
    expect(w).toHaveLength(1);
    expect(w[0].start.toISOString()).toBe(iso(MON, H(9)));
    expect(w[0].end.toISOString()).toBe(iso(MON, H(18)));
  });

  it("staff windows are intersected with business hours", () => {
    const w = workingWindows(base, "ioana", TUE);
    expect(w.map((x) => [x.start.toISOString(), x.end.toISOString()])).toEqual([
      [iso(TUE, H(9)), iso(TUE, H(16))],
    ]);
  });

  it("staff with rules on other weekdays are off on a day with none", () => {
    expect(workingWindows(base, "ioana", MON)).toEqual([]);
  });

  it("business closed on Sunday means nobody works", () => {
    expect(workingWindows(base, "andrei", SUN)).toEqual([]);
  });

  it("a closed override for the business wins over weekly rules", () => {
    const cfg: AvailabilityConfig = {
      ...base,
      overrides: [{ staffId: null, date: MON, closed: true, startMin: null, endMin: null }],
    };
    expect(workingWindows(cfg, "andrei", MON)).toEqual([]);
  });

  it("a custom-hours override replaces that day's rules for the staff member only", () => {
    const cfg: AvailabilityConfig = {
      ...base,
      overrides: [{ staffId: "andrei", date: MON, closed: false, startMin: H(12), endMin: H(20) }],
    };
    const w = workingWindows(cfg, "andrei", MON);
    // 12:00-20:00 clipped by the business's 09:00-18:00.
    expect(w.map((x) => [x.start.toISOString(), x.end.toISOString()])).toEqual([
      [iso(MON, H(12)), iso(MON, H(18))],
    ]);
    expect(workingWindows(cfg, "mihai", MON)[0].start.toISOString()).toBe(iso(MON, H(9)));
  });

  it("supports split shifts (two rules on one weekday)", () => {
    const cfg: AvailabilityConfig = {
      ...base,
      rules: [
        ...base.rules,
        { staffId: "mihai", weekday: 1, startMin: H(9), endMin: H(12) },
        { staffId: "mihai", weekday: 1, startMin: H(14), endMin: H(18) },
      ],
    };
    const w = workingWindows(cfg, "mihai", MON);
    expect(w).toHaveLength(2);
    expect(w[1].start.toISOString()).toBe(iso(MON, H(14)));
  });

  it("keeps 09:00 local at 09:00 across the DST switch", () => {
    // Last Sunday of March 2030 is the 31st; the following Monday is April 1.
    const cfg: AvailabilityConfig = {
      ...base,
      rules: [{ staffId: null, weekday: 0, startMin: H(9), endMin: H(12) }],
    };
    const w = workingWindows(cfg, "x", "2030-03-31");
    expect(w[0].start.toISOString()).toBe("2030-03-31T06:00:00.000Z"); // UTC+3 after switch
    expect(workingWindows(cfg, "x", "2030-03-24")[0].start.toISOString()).toBe(
      "2030-03-24T07:00:00.000Z", // UTC+2 before
    );
  });
});

describe("interval helpers", () => {
  const at = (h: number) => new Date(Date.UTC(2030, 0, 1, h));
  it("normalise merges overlapping and touching intervals, drops empty ones", () => {
    const out = normalise([
      { start: at(9), end: at(10) },
      { start: at(10), end: at(11) },
      { start: at(13), end: at(12) },
      { start: at(10), end: at(12) },
    ]);
    expect(out).toEqual([{ start: at(9), end: at(12) }]);
  });
  it("intersectAll keeps only shared time", () => {
    const out = intersectAll(
      [{ start: at(9), end: at(12) }],
      [
        { start: at(8), end: at(10) },
        { start: at(11), end: at(14) },
      ],
    );
    expect(out).toEqual([
      { start: at(9), end: at(10) },
      { start: at(11), end: at(12) },
    ]);
  });
  it("containedIn requires one window to cover the whole interval", () => {
    const windows = [
      { start: at(9), end: at(10) },
      { start: at(10), end: at(11) },
    ];
    expect(containedIn({ start: at(9), end: at(10) }, windows)).toBe(true);
    expect(containedIn({ start: at(9), end: at(11) }, windows)).toBe(false);
  });
});
