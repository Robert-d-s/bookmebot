import Link from "next/link";
import { requireUser } from "@/server/auth/session";
import { getBusiness } from "@/server/dashboard/queries";
import { listEvents } from "@/server/webhooks";
import { replayEventAction } from "../actions";
import { Badge, buttonSecondary, card } from "../_components/ui";
import { fmtDateTime } from "../_lib/format";

const STATUSES = ["", "DEAD", "FAILED", "DEFERRED", "RECEIVED", "PROCESSED", "SKIPPED"] as const;
type Status = Exclude<(typeof STATUSES)[number], "">;

export default async function EventsPage(props: PageProps<"/dashboard/events">) {
  const user = await requireUser();
  const sp = await props.searchParams;
  const status =
    STATUSES.includes(sp.status as Status) && sp.status ? (sp.status as Status) : undefined;
  const [business, events] = await Promise.all([
    getBusiness(user.businessId),
    listEvents({ status, limit: 100 }),
  ]);
  const tz = business.timezone;

  return (
    <>
      <h1 className="text-xl font-semibold">Inbound events</h1>
      <div className="flex flex-wrap gap-2 text-sm">
        {STATUSES.map((s) => (
          <Link
            key={s}
            href={s ? `/dashboard/events?status=${s}` : "/dashboard/events"}
            className={`${buttonSecondary} ${(status ?? "") === s ? "ring-2 ring-zinc-500" : ""}`}
          >
            {s || "All"}
          </Link>
        ))}
      </div>
      <div className={`${card} overflow-x-auto`}>
        <table className="w-full text-sm">
          <thead className="text-left text-zinc-500">
            <tr>
              <th className="py-1 pr-3">Received</th>
              <th className="py-1 pr-3">Provider</th>
              <th className="py-1 pr-3">Type</th>
              <th className="py-1 pr-3">Key</th>
              <th className="py-1 pr-3">Status</th>
              <th className="py-1 pr-3">Attempts</th>
              <th className="py-1 pr-3">Last error / result</th>
              <th className="py-1"></th>
            </tr>
          </thead>
          <tbody>
            {events.length === 0 && (
              <tr>
                <td colSpan={8} className="py-2 text-zinc-500">
                  No events.
                </td>
              </tr>
            )}
            {events.map((e) => (
              <tr key={e.id} className="border-t align-top">
                <td className="py-1 pr-3 whitespace-nowrap">{fmtDateTime(e.receivedAt, tz)}</td>
                <td className="py-1 pr-3">{e.provider}</td>
                <td className="py-1 pr-3">{e.eventType}</td>
                <td className="py-1 pr-3 font-mono text-xs">{e.correlationKey ?? "—"}</td>
                <td className="py-1 pr-3">
                  <Badge status={e.status} />
                </td>
                <td className="py-1 pr-3">
                  {e.attempts}
                  {e.nextAttemptAt && (
                    <span className="block text-xs text-zinc-500">
                      next {fmtDateTime(e.nextAttemptAt, tz)}
                    </span>
                  )}
                </td>
                <td className="max-w-md py-1 pr-3 text-xs">
                  {e.lastError && (
                    <span className="text-red-700 dark:text-red-300">{e.lastError}</span>
                  )}
                  {e.result != null && (
                    <code className="block text-zinc-500">{JSON.stringify(e.result)}</code>
                  )}
                </td>
                <td className="py-1">
                  {(e.status === "DEAD" || e.status === "FAILED" || e.status === "DEFERRED") && (
                    <form action={replayEventAction}>
                      <input type="hidden" name="id" value={e.id} />
                      <button className="text-xs underline">replay now</button>
                    </form>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
