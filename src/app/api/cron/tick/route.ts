import { NextResponse, type NextRequest } from "next/server";
import { requireInternalSecret } from "@/server/http/internal-auth";
import { sweepPayments } from "@/server/payments";
import { releaseExpiredHolds } from "@/server/scheduling";
import { processDue } from "@/server/webhooks";

export const dynamic = "force-dynamic";

/**
 * One scheduled entry point for all background work, so a single free-tier
 * cron (Vercel Cron or a GitHub Actions schedule) keeps everything moving:
 * retry due webhook events and release expired booking holds.
 */
export async function GET(req: NextRequest) {
  const denied = requireInternalSecret(req);
  if (denied) return denied;

  const [webhooks, releasedHolds] = await Promise.all([processDue(), releaseExpiredHolds()]);
  const payments = await sweepPayments();
  return NextResponse.json({
    ok: true,
    at: new Date().toISOString(),
    webhooks,
    releasedHolds,
    payments,
  });
}
