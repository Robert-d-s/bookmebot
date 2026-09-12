import { NextResponse } from "next/server";
import { prisma } from "@/server/db/prisma";

export const dynamic = "force-dynamic";

/**
 * Liveness + DB reachability. Also the target of the GitHub Actions keep-alive
 * job that stops the Supabase free-tier project from pausing.
 */
export async function GET() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return NextResponse.json({ ok: true, db: "up", at: new Date().toISOString() });
  } catch (error) {
    return NextResponse.json(
      { ok: false, db: "down", error: error instanceof Error ? error.message : "unknown" },
      { status: 503 },
    );
  }
}
