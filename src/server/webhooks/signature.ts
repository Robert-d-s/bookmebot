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
