import { requireUser } from "@/server/auth/session";
import { getBusiness } from "@/server/dashboard/queries";
import { prisma } from "@/server/db/prisma";
import { Thread } from "../_components/thread";
import { button, buttonSecondary, card, input } from "../_components/ui";
import { sendAsCustomerAction } from "./actions";

/**
 * A fake customer phone. Everything typed here travels the same path as a
 * WhatsApp message: signed webhook -> event -> handler -> responder -> OUT.
 */
export default async function SimulatorPage(props: PageProps<"/dashboard/simulator">) {
  const user = await requireUser();
  const sp = await props.searchParams;
  const phone = typeof sp.phone === "string" && sp.phone ? sp.phone : "+40799000001";
  const [business, customer] = await Promise.all([
    getBusiness(user.businessId),
    prisma.customer.findUnique({
      where: { businessId_phone: { businessId: user.businessId, phone } },
      include: { messages: { orderBy: { createdAt: "asc" }, take: 200 } },
    }),
  ]);

  const replyForm = (opt: { id: string; title: string }) => (
    <form action={sendAsCustomerAction} className="inline">
      <input type="hidden" name="phone" value={phone} />
      <input type="hidden" name="replyId" value={opt.id} />
      <input type="hidden" name="replyTitle" value={opt.title} />
      <button className="rounded border bg-white px-2 py-0.5 text-xs hover:bg-zinc-50 dark:bg-zinc-900 dark:hover:bg-zinc-700">
        {opt.title}
      </button>
    </form>
  );

  return (
    <>
      <h1 className="text-xl font-semibold">Chat simulator</h1>
      <p className="text-sm text-zinc-500">
        You are the customer. Messages go through the webhook layer exactly like WhatsApp traffic;
        see them under Events too.
      </p>
      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <section className={`${card} space-y-4`}>
          <Thread
            messages={customer?.messages ?? []}
            timezone={business.timezone}
            replyForm={replyForm}
          />
          <form action={sendAsCustomerAction} className="flex gap-2">
            <input type="hidden" name="phone" value={phone} />
            <input
              name="text"
              placeholder="Type as the customer…"
              required
              autoFocus
              className={`${input} flex-1`}
            />
            <button className={button}>Send</button>
          </form>
        </section>
        <section className={`${card} space-y-3 text-sm`}>
          <form className="space-y-2">
            <label className="block">
              Customer phone
              <input name="phone" defaultValue={phone} className={`${input} mt-1 block w-full`} />
            </label>
            <button className={buttonSecondary}>Switch</button>
          </form>
          {customer && (
            <p className="text-zinc-500">
              {customer.name ?? "Unnamed"} · {customer.messages.length} messages ·{" "}
              <a className="underline" href={`/dashboard/customers/${customer.id}`}>
                customer page
              </a>
            </p>
          )}
          <p className="text-xs text-zinc-500">
            Try: “hi”, “what are your hours?”, “prices”, or tap a button in the last reply.
          </p>
        </section>
      </div>
    </>
  );
}
