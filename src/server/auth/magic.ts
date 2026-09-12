import { env } from "@/env";
import { prisma } from "@/server/db/prisma";
import { getEmailSender } from "@/server/email";
import { hmacSha256Hex, safeEqual } from "@/server/webhooks/signature";

/**
 * Passwordless sign-in without an adapter: a signed, expiring token in a link.
 * The link lands on a page with a button (not an auto-login), so mail scanners
 * that prefetch links cannot consume it.
 */
const TTL_MS = 15 * 60_000;

export function issueMagicToken(email: string, now: Date = new Date()): string {
  const payload = Buffer.from(
    JSON.stringify({ e: email.toLowerCase(), x: now.getTime() + TTL_MS }),
  ).toString("base64url");
  return `${payload}.${hmacSha256Hex(env.AUTH_SECRET, `magic:${payload}`)}`;
}

export function verifyMagicToken(
  token: string | null | undefined,
  now: Date = new Date(),
): string | null {
  if (!token) return null;
  const i = token.lastIndexOf(".");
  if (i < 0) return null;
  const payload = token.slice(0, i);
  if (!safeEqual(token.slice(i + 1), hmacSha256Hex(env.AUTH_SECRET, `magic:${payload}`)))
    return null;
  try {
    const { e, x } = JSON.parse(Buffer.from(payload, "base64url").toString()) as {
      e: string;
      x: number;
    };
    return typeof e === "string" && typeof x === "number" && x > now.getTime() ? e : null;
  } catch {
    return null;
  }
}

/** Sends the link if the address belongs to a user; says nothing either way (no enumeration). */
export async function sendMagicLink(email: string): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { email: email.toLowerCase() },
    select: { email: true },
  });
  if (!user) return;
  const url = `${env.APP_URL}/auth/magic?token=${encodeURIComponent(issueMagicToken(user.email))}`;
  await getEmailSender().send({
    to: user.email,
    subject: "Your BookMeBot sign-in link",
    text: `Sign in to the dashboard (valid 15 minutes):\n${url}\n\nIf you did not request this, ignore this email.`,
  });
}
