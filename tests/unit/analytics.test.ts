import { afterEach, describe, expect, it } from "vitest";
import { setAnalyticsClient, track } from "@/server/analytics";

describe("analytics", () => {
  afterEach(() => setAnalyticsClient(undefined));

  it("is a no-op without a client and forwards with one", () => {
    expect(() => track("biz", "booking_created", { source: "API" })).not.toThrow();
    const seen: unknown[] = [];
    setAnalyticsClient({ capture: (e) => void seen.push(e) });
    track("biz", "payment_paid", { amountCents: 500 });
    expect(seen).toEqual([
      { distinctId: "biz", event: "payment_paid", properties: { amountCents: 500 } },
    ]);
  });
});
