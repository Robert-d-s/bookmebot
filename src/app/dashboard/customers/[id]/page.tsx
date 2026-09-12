import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/server/auth/session";
import { getBusiness } from "@/server/dashboard/queries";
import { prisma } from "@/server/db/prisma";
import { setConversationModeAction } from "../../actions";
import { Thread } from "../../_components/thread";
import { Badge, buttonSecondary, card } from "../../_components/ui";
import { fmtDateTime } from "../../_lib/format";

export default async function CustomerPage(props: PageProps<"/dashboard/customers/[id]">) {
  const user = await requireUser();
  const { id } = await props.params;
  const [business, customer] = await Promise.all([
    getBusiness(user.businessId),
    prisma.customer.findFirst({
      where: { id, businessId: user.businessId },
      include: {
        bookings: { orderBy: { startsAt: "desc" }, include: { service: true, staff: true } },
        messages: { orderBy: { createdAt: "asc" }, take: 500 },
        conversation: { select: { mode: true, state: true } },
      },
    }),
  ]);
  if (!customer) notFound();
  const tz = business.timezone;
  const mode = customer.conversation?.mode ?? "BOT";

  return (
    <>
      <h1 className="text-xl font-semibold">
        {customer.name ?? "Unnamed"}{" "}
        <span className="font-mono text-base text-zinc-500">{customer.phone}</span>
      </h1>
      <div className="grid gap-6 lg:grid-cols-2">
        <section className={card}>
          <h2 className="mb-2 font-medium">Bookings</h2>
          <ul className="space-y-1 text-sm">
            {customer.bookings.length === 0 && <li className="text-zinc-500">None yet.</li>}
            {customer.bookings.map((b) => (
              <li key={b.id}>
                <Link
                  href={`/dashboard/bookings/${b.id}`}
                  className="flex items-center gap-2 hover:underline"
                >
                  <span>{fmtDateTime(b.startsAt, tz)}</span>
                  <span className="text-zinc-500">
                    {b.service.name} · {b.staff.name}
                  </span>
                  <Badge status={b.status} />
                </Link>
              </li>
            ))}
          </ul>
        </section>
        <section className={card}>
          <div className="mb-2 flex items-center gap-3">
            <h2 className="font-medium">Messages</h2>
            <Badge status={mode === "BOT" ? "PROCESSED" : "DEFERRED"} />
            <span className="text-xs text-zinc-500">
              {mode === "BOT" ? "bot answers" : "bot paused, a person replies"}
            </span>
            <form action={setConversationModeAction} className="ml-auto">
              <input type="hidden" name="customerId" value={customer.id} />
              <input type="hidden" name="mode" value={mode === "BOT" ? "HUMAN" : "BOT"} />
              <button className={buttonSecondary}>
                {mode === "BOT" ? "Pause bot" : "Resume bot"}
              </button>
            </form>
          </div>
          <Thread messages={customer.messages} timezone={tz} />
        </section>
      </div>
    </>
  );
}
