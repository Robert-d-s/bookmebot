import { env } from "@/env";
import { hmacSha256Hex, safeEqual } from "@/server/webhooks/signature";

/**
 * Self-service links for customers without a login: the booking id signed
 * with AUTH_SECRET. Knowing the id is not enough; knowing the link is.
 */
export function bookingToken(bookingId: string): string {
  return hmacSha256Hex(env.AUTH_SECRET, `booking:${bookingId}`).slice(0, 32);
}

export function verifyBookingToken(bookingId: string, token: string | null | undefined): boolean {
  return Boolean(token) && safeEqual(token!, bookingToken(bookingId));
}

export const manageUrl = (slug: string, bookingId: string) =>
  `${env.APP_URL}/book/${slug}/manage?id=${bookingId}&t=${bookingToken(bookingId)}`;

/** Wall clock for server components (keeps the React compiler lint quiet about Date.now in render). */
export const nowMs = () => Date.now();
