import { NextResponse, type NextRequest } from "next/server";
import { requireInternalSecret } from "@/server/http/internal-auth";
import { replayEvent } from "@/server/webhooks";

export const dynamic = "force-dynamic";

/** POST /api/admin/events/:id/replay  (re-run a dead or failed event now) */
export async function POST(req: NextRequest, ctx: RouteContext<"/api/admin/events/[id]/replay">) {
  const denied = requireInternalSecret(req);
  if (denied) return denied;
  const { id } = await ctx.params;
  const outcome = await replayEvent(id);
  if (!outcome) return NextResponse.json({ error: "NOT_REPLAYABLE" }, { status: 409 });
  return NextResponse.json({ ok: true, outcome });
}
