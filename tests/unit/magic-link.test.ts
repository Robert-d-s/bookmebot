import { describe, expect, it } from "vitest";
import { issueMagicToken, verifyMagicToken } from "@/server/auth/magic";

describe("magic link token", () => {
  const now = new Date("2026-09-12T10:00:00Z");
  it("round-trips the email, lower-cased, within 15 minutes", () => {
    const t = issueMagicToken("Owner@Frizeria.demo", now);
    expect(verifyMagicToken(t, now)).toBe("owner@frizeria.demo");
    expect(verifyMagicToken(t, new Date(now.getTime() + 14 * 60_000))).toBe("owner@frizeria.demo");
    expect(verifyMagicToken(t, new Date(now.getTime() + 16 * 60_000))).toBeNull();
  });
  it("rejects tampering and garbage", () => {
    const t = issueMagicToken("a@b.c", now);
    const [payload, sig] = t.split(".");
    expect(verifyMagicToken(`${payload}x.${sig}`, now)).toBeNull();
    expect(verifyMagicToken(`${payload}.${sig.replace(/^./, "0")}`, now)).toBeNull();
    expect(verifyMagicToken("nodot", now)).toBeNull();
    expect(verifyMagicToken(null, now)).toBeNull();
  });
});
