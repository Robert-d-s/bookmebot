import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireInternalSecret } from "@/server/http/internal-auth";
import { handle } from "@/server/http/errors";
import { listEvents } from "@/server/webhooks";

export const dynamic = "force-dynamic";

const query = z.object({
  status: z
    .enum(["RECEIVED", "PROCESSING", "PROCESSED", "SKIPPED", "FAILED", "DEFERRED", "DEAD"])
    .optional(),
  provider: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

/** GET /api/admin/events?status=DEAD  (dead-letter inspection) */
export async function GET(req: NextRequest) {
  const denied = requireInternalSecret(req);
  if (denied) return denied;
  return handle(async () => {
    const q = query.parse(Object.fromEntries(req.nextUrl.searchParams));
    return NextResponse.json({ events: await listEvents(q) });
  });
}
