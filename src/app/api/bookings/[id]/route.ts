import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { businessIdBySlug } from "@/server/customers";
import { handle } from "@/server/http/errors";
import { cancelBooking, rescheduleBooking } from "@/server/scheduling";

export const dynamic = "force-dynamic";

const patchBody = z.object({
  business: z.string().min(1),
  startsAt: z.coerce.date(),
  staff: z.union([z.string().uuid(), z.literal("any")]).optional(),
  expectedVersion: z.number().int().positive().optional(),
});

/** PATCH /api/bookings/:id  { business, startsAt, staff?, expectedVersion? } */
export async function PATCH(req: NextRequest, ctx: RouteContext<"/api/bookings/[id]">) {
  return handle(async () => {
    const { id } = await ctx.params;
    const input = patchBody.parse(await req.json());
    const booking = await rescheduleBooking({
      businessId: await businessIdBySlug(input.business),
      bookingId: id,
      startsAt: input.startsAt,
      staffId: input.staff,
      expectedVersion: input.expectedVersion,
    });
    return NextResponse.json({ booking });
  });
}

const deleteQuery = z.object({ business: z.string().min(1) });

/** DELETE /api/bookings/:id?business=<slug> */
export async function DELETE(req: NextRequest, ctx: RouteContext<"/api/bookings/[id]">) {
  return handle(async () => {
    const { id } = await ctx.params;
    const q = deleteQuery.parse(Object.fromEntries(req.nextUrl.searchParams));
    const booking = await cancelBooking({
      businessId: await businessIdBySlug(q.business),
      bookingId: id,
    });
    return NextResponse.json({ booking });
  });
}
