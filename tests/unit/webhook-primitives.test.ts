import { describe, expect, it } from "vitest";
import { MAX_ATTEMPTS, backoffMs } from "@/server/webhooks/process";
import { hmacSha256Hex, safeEqual, verifySha256Header } from "@/server/webhooks/signature";

describe("signature", () => {
  const secret = "s3cret";
  const body = '{"events":[{"id":"1"}]}';

  it("accepts the right sha256= header and rejects everything else", () => {
    const good = `sha256=${hmacSha256Hex(secret, body)}`;
    expect(verifySha256Header(secret, body, good)).toBe(true);
    expect(verifySha256Header(secret, body + " ", good)).toBe(false);
    expect(verifySha256Header("other", body, good)).toBe(false);
    expect(verifySha256Header(secret, body, null)).toBe(false);
    expect(verifySha256Header(secret, body, "md5=abc")).toBe(false);
    expect(verifySha256Header(secret, body, "sha256=")).toBe(false);
  });

  it("safeEqual tolerates length mismatch", () => {
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(safeEqual("abc", "abc")).toBe(true);
  });
});

describe("backoff", () => {
  it("doubles per attempt, caps at an hour, adds up to 20% jitter", () => {
    const noJitter = () => 0;
    expect(backoffMs(1, noJitter)).toBe(60_000);
    expect(backoffMs(2, noJitter)).toBe(120_000);
    expect(backoffMs(5, noJitter)).toBe(960_000);
    expect(backoffMs(20, noJitter)).toBe(3_600_000);
    expect(backoffMs(1, () => 1)).toBe(72_000);
    expect(MAX_ATTEMPTS).toBe(5);
  });
});
