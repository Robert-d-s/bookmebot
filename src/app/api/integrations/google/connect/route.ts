import { NextResponse } from "next/server";
import { auth } from "@/server/auth";
import { buildAuthUrl } from "@/server/calendar/oauth";
import { googleConfigured } from "@/server/calendar/api";

export const dynamic = "force-dynamic";

/** Owner clicks "Connect Google Calendar": off to Google's consent screen. */
export async function GET() {
  const session = await auth();
  if (!session?.user?.businessId)
    return NextResponse.redirect(new URL("/login", process.env.APP_URL ?? "http://localhost:3000"));
  if (!googleConfigured())
    return NextResponse.json({ error: "GOOGLE_NOT_CONFIGURED" }, { status: 503 });
  return NextResponse.redirect(buildAuthUrl(session.user.businessId));
}
