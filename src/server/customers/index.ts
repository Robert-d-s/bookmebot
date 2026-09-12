import { prisma } from "@/server/db/prisma";
import { NotFoundError } from "@/server/scheduling/errors";

/** Business id for a public slug, or 404. */
export async function businessIdBySlug(slug: string): Promise<string> {
  const b = await prisma.business.findUnique({ where: { slug }, select: { id: true } });
  if (!b) throw new NotFoundError("business", slug);
  return b.id;
}

/**
 * Customers are identified by phone within a business (WhatsApp sender id
 * later). First contact creates the row; a later name fills in a blank one.
 */
export async function findOrCreateCustomer(
  businessId: string,
  phone: string,
  name?: string,
  email?: string,
) {
  return prisma.customer.upsert({
    where: { businessId_phone: { businessId, phone } },
    create: { businessId, phone, name, email },
    update: { ...(name ? { name } : {}), ...(email ? { email } : {}) },
    select: { id: true, phone: true, name: true, email: true },
  });
}
