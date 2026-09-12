import { NextResponse, after, type NextRequest } from "next/server";
import { ingest, processEvent } from "@/server/webhooks";
import { getProvider } from "@/server/webhooks/registry";

export const dynamic = "force-dynamic";

/**
 * Generic inbound receiver. POST /api/webhooks/<provider>
 *
 * Persist first, answer fast, process after the response has gone out.
 * Providers retry on non-2xx, so anything that is our fault (a crashed
 * handler) must still answer 200: the event is safe in the database and the
 * sweeper will get to it.
 */
export async function POST(req: NextRequest, ctx: RouteContext<"/api/webhooks/[provider]">) {
  const { provider } = await ctx.params;
  const rawBody = await req.text();
  const result = await ingest(provider, rawBody, req.headers);

  if (result.status === 200) {
    const ids = result.newEventIds;
    after(async () => {
      for (const id of ids) await processEvent(id);
    });
    return NextResponse.json({
      ok: true,
      deliveryId: result.deliveryId,
      accepted: ids.length,
      duplicates: result.duplicateCount,
    });
  }
  return NextResponse.json(result, { status: result.status });
}

/** Endpoint verification handshake for providers that do one (Meta). */
export async function GET(req: NextRequest, ctx: RouteContext<"/api/webhooks/[provider]">) {
  const { provider } = await ctx.params;
  const p = getProvider(provider);
  if (!p) return NextResponse.json({ error: "UNKNOWN_PROVIDER" }, { status: 404 });
  return p.challenge?.(req.nextUrl) ?? NextResponse.json({ ok: true, provider: p.name });
}
