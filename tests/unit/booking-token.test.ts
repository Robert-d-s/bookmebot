import { describe, expect, it } from "vitest";
import { bookingToken, manageUrl, verifyBookingToken } from "@/server/bookings/token";

describe("booking token", () => {
  it("verifies its own token and nothing else", () => {
    const t = bookingToken("b1");
    expect(verifyBookingToken("b1", t)).toBe(true);
    expect(verifyBookingToken("b2", t)).toBe(false);
    expect(verifyBookingToken("b1", t.slice(0, -1) + "0")).toBe(false);
    expect(verifyBookingToken("b1", null)).toBe(false);
    expect(manageUrl("salon", "b1")).toContain(`/book/salon/manage?id=b1&t=${t}`);
  });
});
