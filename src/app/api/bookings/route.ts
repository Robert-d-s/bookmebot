import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { businessIdBySlug, findOrCreateCustomer } from "@/server/customers";
import { handle } from "@/server/http/errors";
import { createBooking } from "@/server/bookings";

export const dynamic = "force-dynamic";

const body = z.object({
  business: z.string().min(1),
  service: z.string().uuid(),
  staff: z.string().uuid().optional(),
  startsAt: z.coerce.date(),
  customer: z.object({
    phone: z.string().regex(/^\+[1-9]\d{6,14}$/, "E.164 phone expected"),
    name: z.string().min(1).max(100).optional(),
  }),
  notes: z.string().max(500).optional(),
});

/**
 * POST /api/bookings
 * No auth yet (phase 3): this is the local demo surface for the engine.
 */
export async function POST(req: NextRequest) {
  return handle(async () => {
    const input = body.parse(await req.json());
    const businessId = await businessIdBySlug(input.business);
    const customer = await findOrCreateCustomer(
      businessId,
      input.customer.phone,
      input.customer.name,
    );
    const { booking, payment } = await createBooking({
      businessId,
      serviceId: input.service,
      staffId: input.staff,
      customerId: customer.id,
      startsAt: input.startsAt,
      notes: input.notes,
      source: "API",
    });
    return NextResponse.json({ booking, payment }, { status: 201 });
  });
}
