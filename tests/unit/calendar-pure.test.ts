import { describe, expect, it } from "vitest";
import { FakeCalendarApi, SyncTokenExpired } from "@/server/calendar/api";
import { buildAuthUrl, signState, verifyState } from "@/server/calendar/oauth";

const conn = {
  id: "c1",
  calendarId: "primary",
  accessToken: null,
  refreshToken: null,
  expiresAt: null,
};

describe("oauth state", () => {
  it("round-trips and rejects tampering", () => {
    const s = signState("biz-1");
    expect(verifyState(s)).toBe("biz-1");
    expect(verifyState(s.replace("biz-1", "biz-2"))).toBeNull();
    expect(verifyState("nodot")).toBeNull();
    expect(verifyState(null)).toBeNull();
  });
  it("buildAuthUrl needs configuration", () => {
    if (process.env.GOOGLE_CLIENT_ID) {
      const u = new URL(buildAuthUrl("biz-1"));
      expect(u.searchParams.get("access_type")).toBe("offline");
      expect(u.searchParams.get("scope")).toContain("calendar.events");
    } else {
      expect(() => buildAuthUrl("biz-1")).toThrow(/not configured/);
    }
  });
});

describe("FakeCalendarApi incremental sync", () => {
  it("returns only changes since the token, including cancellations, and expires like Google", async () => {
    const api = new FakeCalendarApi();
    const ev = {
      summary: "x",
      start: new Date("2030-01-07T08:00:00Z"),
      end: new Date("2030-01-07T08:30:00Z"),
      timeZone: "UTC",
      bookingId: "b",
    };
    const id = await api.insert(conn, ev);
    const full = await api.list(conn, {
      timeMin: new Date("2030-01-01T00:00:00Z"),
      timeMax: new Date("2030-02-01T00:00:00Z"),
    });
    expect(full.events.map((e) => e.id)).toEqual([id]);
    expect(full.events[0].private).toMatchObject({ bookmebot: "1", bookingId: "b" });

    const foreign = api.addForeign(conn, {
      start: new Date("2030-01-08T08:00:00Z"),
      end: new Date("2030-01-08T09:00:00Z"),
      summary: "Dentist",
    });
    const inc = await api.list(conn, { syncToken: full.nextSyncToken });
    expect(inc.events.map((e) => e.id)).toEqual([foreign]);

    api.cancelForeign(conn, foreign);
    const inc2 = await api.list(conn, { syncToken: inc.nextSyncToken });
    expect(inc2.events).toEqual([expect.objectContaining({ id: foreign, status: "cancelled" })]);

    api.expireTokens();
    await expect(api.list(conn, { syncToken: inc2.nextSyncToken })).rejects.toBeInstanceOf(
      SyncTokenExpired,
    );
  });
});
