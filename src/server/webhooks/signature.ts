import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * HMAC-SHA256 over the raw body, hex encoded. Meta (WhatsApp) uses exactly
 * this in `X-Hub-Signature-256: sha256=<hex>`; the simulator copies it.
 * Stripe's scheme is different and will get its own helper in phase 6.
 */
export function hmacSha256Hex(secret: string, rawBody: string): string {
  return createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
}

/** Constant-time comparison that also tolerates length mismatch without throwing. */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Verify a `sha256=<hex>` header value. Missing or malformed => false. */
export function verifySha256Header(
  secret: string,
  rawBody: string,
  headerValue: string | null,
): boolean {
  if (!headerValue) return false;
  const [scheme, hex] = headerValue.split("=", 2);
  if (scheme !== "sha256" || !hex) return false;
  return safeEqual(hex, hmacSha256Hex(secret, rawBody));
}

/**
 * Stripe's scheme: `Stripe-Signature: t=<unix>,v1=<hex>[,v1=<hex>...]` where the
 * signed payload is `${t}.${rawBody}` and the key is the endpoint's whsec_ secret.
 * Timestamps older than `toleranceSec` are rejected to blunt replay.
 */
export function verifyStripeHeader(
  secret: string,
  rawBody: string,
  headerValue: string | null,
  now: Date = new Date(),
  toleranceSec = 300,
): boolean {
  if (!headerValue) return false;
  const parts = headerValue.split(",").map((p) => p.trim().split("=", 2));
  const t = parts.find(([k]) => k === "t")?.[1];
  const sigs = parts.filter(([k]) => k === "v1").map(([, v]) => v);
  if (!t || sigs.length === 0 || !/^\d+$/.test(t)) return false;
  if (Math.abs(now.getTime() / 1000 - Number(t)) > toleranceSec) return false;
  const expected = hmacSha256Hex(secret, `${t}.${rawBody}`);
  return sigs.some((s) => safeEqual(s, expected));
}

/** Build a Stripe-Signature header (used by the fake gateway and tests). */
export function signStripe(secret: string, rawBody: string, now: Date = new Date()): string {
  const t = Math.floor(now.getTime() / 1000);
  return `t=${t},v1=${hmacSha256Hex(secret, `${t}.${rawBody}`)}`;
}
