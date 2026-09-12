import { NextResponse, type NextRequest } from "next/server";
import { env } from "@/env";
import { auth } from "@/server/auth";
import { exchangeCode, verifyState } from "@/server/calendar/oauth";
import { prisma } from "@/server/db/prisma";

export const dynamic = "force-dynamic";

/** Google sends the owner back here with a code; we store tokens on the business. */
export async function GET(req: NextRequest) {
  const back = (q: string) =>
    NextResponse.redirect(new URL(`/dashboard/calendar?${q}`, env.APP_URL));
  const session = await auth();
  if (!session?.user?.businessId) return NextResponse.redirect(new URL("/login", env.APP_URL));

  const businessId = verifyState(req.nextUrl.searchParams.get("state"));
  const code = req.nextUrl.searchParams.get("code");
  if (!businessId || businessId !== session.user.businessId || !code)
    return back("error=bad-state");

  try {
    const tokens = await exchangeCode(code);
    const existing = await prisma.calendarConnection.findFirst({
      where: { businessId, staffId: null },
    });
    if (existing) {
      await prisma.calendarConnection.update({
        where: { id: existing.id },
        data: { provider: "google", ...tokens, syncToken: null, lastError: null },
      });
    } else {
      await prisma.calendarConnection.create({
        data: { businessId, provider: "google", ...tokens },
      });
    }
    return back("ok=connected");
  } catch (err) {
    return back(
      `error=${encodeURIComponent(err instanceof Error ? err.message : "exchange failed")}`,
    );
  }
}
