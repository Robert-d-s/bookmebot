import Link from "next/link";
import { requireUser } from "@/server/auth/session";
import { getBusiness, getCustomers } from "@/server/dashboard/queries";
import { Badge, card } from "../_components/ui";
import { fmtDateTime } from "../_lib/format";

export default async function CustomersPage() {
  const user = await requireUser();
  const [business, customers] = await Promise.all([
    getBusiness(user.businessId),
    getCustomers(user.businessId),
  ]);
  return (
    <>
      <h1 className="text-xl font-semibold">Customers</h1>
      <div className={`${card} overflow-x-auto`}>
        <table className="w-full text-sm">
          <thead className="text-left text-zinc-500">
            <tr>
              <th className="py-1 pr-4">Name</th>
              <th className="py-1 pr-4">Phone</th>
              <th className="py-1 pr-4">Email</th>
              <th className="py-1 pr-4">Bookings</th>
              <th className="py-1 pr-4">Last booking</th>
            </tr>
          </thead>
          <tbody>
            {customers.map((c) => (
              <tr key={c.id} className="border-t">
                <td className="py-1 pr-4">
                  <Link href={`/dashboard/customers/${c.id}`} className="hover:underline">
                    {c.name ?? "—"}
                  </Link>
                </td>
                <td className="py-1 pr-4 font-mono">{c.phone}</td>
                <td className="py-1 pr-4">{c.email ?? "—"}</td>
                <td className="py-1 pr-4">{c._count.bookings}</td>
                <td className="py-1 pr-4">
                  {c.bookings[0] ? (
                    <>
                      {fmtDateTime(c.bookings[0].startsAt, business.timezone)}{" "}
                      <Badge status={c.bookings[0].status} />
                    </>
                  ) : (
                    "—"
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-3 text-xs text-zinc-500">
          Message log arrives with the WhatsApp channel (phase 4).
        </p>
      </div>
    </>
  );
}
