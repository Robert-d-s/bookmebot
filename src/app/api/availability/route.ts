import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { businessIdBySlug } from "@/server/customers";
import { handle } from "@/server/http/errors";
import { getAvailability } from "@/server/scheduling";
import { type LocalDate, addDays, toLocalDate } from "@/server/scheduling/time";
import { prisma } from "@/server/db/prisma";

export const dynamic = "force-dynamic";

const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/) as unknown as z.ZodType<LocalDate>;

const query = z.object({
  business: z.string().min(1),
  service: z.string().uuid(),
  staff: z.string().uuid().optional(),
  from: localDate.optional(),
  to: localDate.optional(),
});

/**
 * GET /api/availability?business=<slug>&service=<id>[&staff=<id>][&from=YYYY-MM-DD][&to=YYYY-MM-DD]
 * Defaults to the next 7 local days.
 */
export async function GET(req: NextRequest) {
  return handle(async () => {
    const q = query.parse(Object.fromEntries(req.nextUrl.searchParams));
    const businessId = await businessIdBySlug(q.business);
    const { timezone } = await prisma.business.findUniqueOrThrow({
      where: { id: businessId },
      select: { timezone: true },
    });
    const from = q.from ?? toLocalDate(new Date(), timezone);
    const to = q.to ?? addDays(from, 6);
    const slots = await getAvailability({
      businessId,
      serviceId: q.service,
      staffId: q.staff,
      from,
      to,
    });
    return NextResponse.json({
      timezone,
      from,
      to,
      slots: slots.map((s) => ({
        start: s.start.toISOString(),
        end: s.end.toISOString(),
        staffIds: s.staffIds,
      })),
    });
  });
}
