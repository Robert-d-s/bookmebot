import { prisma } from "@/server/db/prisma";
import { getGateway } from "@/server/payments";
import { simulatePaymentAction } from "./actions";

/**
 * Where a deposit link lands. With the real gateway the link goes to Stripe
 * and this page is only the success/cancel return. With the fake gateway
 * this page IS the checkout: one button that simulates a successful payment.
 */
export default async function PayPage(props: PageProps<"/pay/[sessionId]">) {
  const { sessionId } = await props.params;
  const sp = await props.searchParams;
  const payment = await prisma.payment.findUnique({
    where: { checkoutSessionId: sessionId },
    include: { booking: { include: { service: true, business: true } } },
  });
  const fake = getGateway()?.mode === "fake";
  const money = payment ? `${(payment.amountCents / 100).toFixed(2)} ${payment.currency}` : "";

  return (
    <main className="flex flex-1 items-center justify-center p-8">
      <div className="w-full max-w-md space-y-4 rounded-lg border p-6">
        {!payment ? (
          <p>Unknown payment.</p>
        ) : (
          <>
            <h1 className="text-xl font-semibold">{payment.booking.business.name}</h1>
            <p className="text-sm">
              Deposit for <strong>{payment.booking.service.name}</strong>: <strong>{money}</strong>
            </p>
            <p className="text-sm">
              Status: <strong>{payment.status}</strong> · booking {payment.booking.status}
            </p>
            {sp.paid && payment.status === "PAID" && (
              <p className="rounded bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">
                Thank you, your booking is confirmed.
              </p>
            )}
            {sp.error && (
              <p className="text-sm text-red-600">Could not simulate: {String(sp.error)}</p>
            )}
            {fake && payment.status === "REQUIRES_PAYMENT" && (
              <form action={simulatePaymentAction} className="space-y-2">
                <input type="hidden" name="sessionId" value={sessionId} />
                <button className="w-full rounded bg-zinc-900 py-2 text-white dark:bg-zinc-100 dark:text-zinc-900">
                  Pay {money} now (simulated)
                </button>
                <p className="text-xs text-zinc-500">
                  Local demo gateway. This posts a signed <code>checkout.session.completed</code>{" "}
                  event to this app&apos;s own Stripe webhook. With real Stripe keys this page is
                  only the return page.
                </p>
              </form>
            )}
            {payment.status === "EXPIRED" && (
              <p className="text-sm text-zinc-500">This payment link has expired.</p>
            )}
          </>
        )}
      </div>
    </main>
  );
}
