import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  type ServiceSpec,
  type SlotQuery,
  appointment,
  checkSlot,
  footprint,
  generateSlots,
} from "@/server/scheduling/slots";
import { type Interval, overlaps } from "@/server/scheduling/time";

const at = (h: number, m = 0) => new Date(Date.UTC(2030, 0, 7, h, m));
const hhmm = (d: Date) => d.toISOString().slice(11, 16);
const service = (over: Partial<ServiceSpec> = {}): ServiceSpec => ({
  durationMin: 30,
  bufferBeforeMin: 0,
  bufferAfterMin: 0,
  requiresResource: false,
  ...over,
});

function query(over: Partial<SlotQuery> = {}): SlotQuery {
  return {
    service: service(),
    staff: [{ staffId: "a", windows: [{ start: at(9), end: at(12) }], busy: [] }],
    resources: [],
    granularityMin: 15,
    earliestStart: at(0),
    latestStart: at(23),
    ...over,
  };
}

describe("generateSlots", () => {
  it("walks the grid and stops when the appointment would overrun the window", () => {
    const starts = generateSlots(query()).map((s) => hhmm(s.start));
    expect(starts[0]).toBe("09:00");
    expect(starts[starts.length - 1]).toBe("11:30");
    expect(starts).toHaveLength(11);
  });

  it("excludes slots whose footprint overlaps a busy interval (closed-open)", () => {
    const q = query();
    q.staff[0].busy = [{ start: at(10), end: at(10, 30) }];
    const starts = generateSlots(q).map((s) => hhmm(s.start));
    expect(starts).not.toContain("09:45");
    expect(starts).not.toContain("10:00");
    expect(starts).not.toContain("10:15");
    expect(starts).toContain("09:30"); // ends exactly at 10:00
    expect(starts).toContain("10:30"); // starts exactly when the other ends
  });

  it("applies the candidate's own buffers", () => {
    const q = query({ service: service({ bufferAfterMin: 10 }) });
    q.staff[0].busy = [{ start: at(10), end: at(10, 30) }];
    // 09:30-10:00 plus 10 min cleanup reaches into the 10:00 booking.
    expect(generateSlots(q).map((s) => hhmm(s.start))).not.toContain("09:30");
  });

  it("respects lead time and max advance", () => {
    const starts = generateSlots(query({ earliestStart: at(10), latestStart: at(11) })).map((s) =>
      hhmm(s.start),
    );
    expect(starts[0]).toBe("10:00");
    expect(starts[starts.length - 1]).toBe("11:00");
  });

  it("anchors the grid at the window's opening time", () => {
    const q = query();
    q.staff[0].windows = [{ start: at(9, 10), end: at(10, 10) }];
    expect(generateSlots(q).map((s) => hhmm(s.start))).toEqual(["09:10", "09:25", "09:40"]);
  });

  it("merges staff per start time", () => {
    const q = query();
    q.staff.push({ staffId: "b", windows: [{ start: at(10), end: at(11) }], busy: [] });
    const slots = generateSlots(q);
    expect(slots.find((s) => hhmm(s.start) === "09:00")?.staffIds).toEqual(["a"]);
    expect(slots.find((s) => hhmm(s.start) === "10:00")?.staffIds).toEqual(["a", "b"]);
  });

  it("needs a free resource when the service requires one", () => {
    const q = query({
      service: service({ requiresResource: true }),
      resources: [{ resourceId: "chair1", busy: [{ start: at(10), end: at(10, 30) }] }],
    });
    expect(generateSlots(q).map((s) => hhmm(s.start))).not.toContain("10:00");
    q.resources.push({ resourceId: "chair2", busy: [] });
    expect(generateSlots(q).map((s) => hhmm(s.start))).toContain("10:00");
  });
});

describe("checkSlot reasons", () => {
  const q = query({ earliestStart: at(9, 30), latestStart: at(11) });
  const staff = q.staff[0];
  it.each([
    [at(9), "TOO_SOON"],
    [at(11, 15), "TOO_FAR"],
    [at(8, 30), "TOO_SOON"],
    [at(11, 45), "TOO_FAR"],
    [at(10, 5), "NOT_ON_GRID"],
  ])("%s -> %s", (start, reason) => {
    expect(checkSlot(q, staff, start)).toEqual({ ok: false, reason });
  });
  it("OUTSIDE_HOURS when the appointment would end after closing", () => {
    const qq = query();
    expect(checkSlot(qq, qq.staff[0], at(11, 45))).toEqual({ ok: false, reason: "OUTSIDE_HOURS" });
  });
  it("STAFF_BUSY and NO_RESOURCE", () => {
    const qq = query({
      service: service({ requiresResource: true }),
      resources: [{ resourceId: "r", busy: [{ start: at(10), end: at(11) }] }],
    });
    expect(checkSlot(qq, qq.staff[0], at(10))).toEqual({ ok: false, reason: "NO_RESOURCE" });
    qq.staff[0].busy = [{ start: at(10), end: at(11) }];
    expect(checkSlot(qq, qq.staff[0], at(10))).toEqual({ ok: false, reason: "STAFF_BUSY" });
  });
});

describe("property: generated slots are always bookable", () => {
  // Arbitrary minutes-from-9:00 in a 12h day.
  const minute = fc.integer({ min: 0, max: 12 * 60 });
  const interval = fc
    .tuple(minute, minute)
    .filter(([a, b]) => a < b)
    .map(([a, b]): Interval => ({ start: at(9, a), end: at(9, b) }));

  it("every slot lies in a window, is on the grid, and its footprint touches no busy interval", () => {
    fc.assert(
      fc.property(
        fc.array(interval, { maxLength: 4 }),
        fc.array(interval, { maxLength: 6 }),
        fc.constantFrom(15, 20, 30),
        fc.record({
          durationMin: fc.constantFrom(20, 30, 45, 60),
          bufferBeforeMin: fc.constantFrom(0, 5, 10),
          bufferAfterMin: fc.constantFrom(0, 5, 10),
        }),
        (windows, busy, granularityMin, svc) => {
          const spec = service(svc);
          const q = query({
            service: spec,
            granularityMin,
            staff: [{ staffId: "a", windows, busy }],
          });
          for (const slot of generateSlots(q)) {
            const appt = appointment(slot.start, spec);
            const window = windows.find((w) => w.start <= appt.start && appt.end <= w.end);
            expect(window).toBeDefined();
            expect(
              (appt.start.getTime() - window!.start.getTime()) % (granularityMin * 60_000),
            ).toBe(0);
            const fp = footprint(appt, spec);
            expect(busy.some((b) => overlaps(b, fp))).toBe(false);
          }
        },
      ),
    );
  });

  it("every grid point that passes checkSlot is offered (no false negatives)", () => {
    fc.assert(
      fc.property(
        fc.array(interval, { maxLength: 3 }),
        fc.array(interval, { maxLength: 5 }),
        (windows, busy) => {
          const q = query({ staff: [{ staffId: "a", windows, busy }] });
          const offered = new Set(generateSlots(q).map((s) => s.start.getTime()));
          for (const w of windows) {
            for (let t = w.start.getTime(); t < w.end.getTime(); t += 15 * 60_000) {
              const ok = checkSlot(q, q.staff[0], new Date(t)).ok;
              expect(offered.has(t)).toBe(ok);
            }
          }
        },
      ),
    );
  });
});
