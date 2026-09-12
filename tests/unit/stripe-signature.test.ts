import { describe, expect, it } from "vitest";
import { signStripe, verifyStripeHeader } from "@/server/webhooks/signature";

describe("Stripe-Signature", () => {
  const secret = "whsec_test";
  const body = '{"id":"evt_1","type":"checkout.session.completed"}';
  const now = new Date("2026-09-12T10:00:00Z");

  it("accepts a fresh, correctly signed header", () => {
    expect(verifyStripeHeader(secret, body, signStripe(secret, body, now), now)).toBe(true);
  });
  it("rejects tampering, wrong secret, and stale timestamps", () => {
    const h = signStripe(secret, body, now);
    expect(verifyStripeHeader(secret, body + " ", h, now)).toBe(false);
    expect(verifyStripeHeader("whsec_other", body, h, now)).toBe(false);
    expect(verifyStripeHeader(secret, body, h, new Date(now.getTime() + 10 * 60_000))).toBe(false);
    expect(verifyStripeHeader(secret, body, null, now)).toBe(false);
    expect(verifyStripeHeader(secret, body, "t=abc,v1=00", now)).toBe(false);
  });
  it("accepts when any v1 matches (key rotation)", () => {
    const t = Math.floor(now.getTime() / 1000);
    const good = signStripe(secret, body, now).split(",")[1];
    expect(verifyStripeHeader(secret, body, `t=${t},v1=deadbeef,${good}`, now)).toBe(true);
  });
});
