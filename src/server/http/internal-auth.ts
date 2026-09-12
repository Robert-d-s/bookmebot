import { NextResponse, type NextRequest } from "next/server";
import { env } from "@/env";
import { safeEqual } from "@/server/webhooks/signature";

/**
 * Bearer-token guard for cron and admin routes. Vercel Cron sends
 * `Authorization: Bearer $CRON_SECRET` by itself; humans and GitHub Actions
 * send the same. Replaced by real sessions for admin routes in phase 3.
 */
export function requireInternalSecret(req: NextRequest): NextResponse | null {
  const header = req.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token || !safeEqual(token, env.CRON_SECRET)) {
    return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  }
  return null;
}
