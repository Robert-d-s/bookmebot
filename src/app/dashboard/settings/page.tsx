import { requireUser } from "@/server/auth/session";
import { getBusiness, getBusinessHours, getCatalog } from "@/server/dashboard/queries";
import {
  createResourceAction,
  createStaffAction,
  saveBusinessHoursAction,
  saveServiceAction,
  toggleResourceAction,
  toggleServiceStaffAction,
  toggleStaffAction,
} from "../actions";
import { Flash, button, buttonSecondary, card, input } from "../_components/ui";
import { WEEKDAYS, minutesToHHMM } from "../_lib/format";

const TYPES = ["CHAIR", "ROOM", "BAY", "STATION"] as const;

export default async function SettingsPage(props: PageProps<"/dashboard/settings">) {
  const user = await requireUser();
  const sp = await props.searchParams;
  const [business, hours, { services, staff, resources }] = await Promise.all([
    getBusiness(user.businessId),
    getBusinessHours(user.businessId),
    getCatalog(user.businessId),
  ]);

  return (
    <>
      <h1 className="text-xl font-semibold">Settings</h1>
      <Flash
        ok={typeof sp.ok === "string" ? sp.ok : undefined}
        error={typeof sp.error === "string" ? sp.error : undefined}
      />
      <p className="text-sm text-zinc-500">
        {business.timezone} · {business.slotGranularityMin}-minute grid · book {business.minLeadMin}{" "}
        min to {business.maxAdvanceDays} days ahead
      </p>

      <section className={card}>
        <h2 className="mb-2 font-medium">Opening hours</h2>
        <form action={saveBusinessHoursAction} className="space-y-1">
          {WEEKDAYS.map((name, weekday) => {
            const rule = hours.find((h) => h.weekday === weekday);
            return (
              <div key={weekday} className="flex items-center gap-3 text-sm">
                <label className="flex w-28 items-center gap-2">
                  <input type="checkbox" name={`open_${weekday}`} defaultChecked={!!rule} /> {name}
                </label>
                <input
                  type="time"
                  name={`start_${weekday}`}
                  defaultValue={minutesToHHMM(rule?.startMin ?? 540)}
                  className={input}
                />
                <span>–</span>
                <input
                  type="time"
                  name={`end_${weekday}`}
                  defaultValue={minutesToHHMM(rule?.endMin ?? 1080)}
                  className={input}
                />
              </div>
            );
          })}
          <button className={`${button} mt-2`}>Save hours</button>
          <p className="text-xs text-zinc-500">
            One window per day. Staff-specific hours and split shifts are supported by the engine
            but edited in the database for now.
          </p>
        </form>
      </section>

      <section className={card}>
        <h2 className="mb-2 font-medium">Services</h2>
        <div className="space-y-3">
          {[...services, null].map((s) => (
            <form
              key={s?.id ?? "new"}
              action={saveServiceAction}
              className="flex flex-wrap items-end gap-2 border-t pt-3 text-sm first:border-t-0 first:pt-0"
            >
              {s && <input type="hidden" name="id" value={s.id} />}
              <label>
                Name
                <input
                  name="name"
                  defaultValue={s?.name}
                  required
                  className={`${input} mt-1 block w-36`}
                />
              </label>
              <label>
                Min
                <input
                  name="durationMin"
                  type="number"
                  min={5}
                  step={5}
                  defaultValue={s?.durationMin ?? 30}
                  className={`${input} mt-1 block w-20`}
                />
              </label>
              <label>
                Price
                <input
                  name="price"
                  type="number"
                  min={0}
                  step="0.01"
                  defaultValue={s ? s.priceCents / 100 : 0}
                  className={`${input} mt-1 block w-24`}
                />
              </label>
              <label>
                Deposit
                <input
                  name="deposit"
                  type="number"
                  min={0}
                  step="0.01"
                  defaultValue={s ? s.depositCents / 100 : 0}
                  className={`${input} mt-1 block w-24`}
                />
              </label>
              <label>
                Buf. before
                <input
                  name="bufferBeforeMin"
                  type="number"
                  min={0}
                  defaultValue={s?.bufferBeforeMin ?? 0}
                  className={`${input} mt-1 block w-20`}
                />
              </label>
              <label>
                Buf. after
                <input
                  name="bufferAfterMin"
                  type="number"
                  min={0}
                  defaultValue={s?.bufferAfterMin ?? 0}
                  className={`${input} mt-1 block w-20`}
                />
              </label>
              <label>
                Needs
                <select
                  name="requiredResourceType"
                  defaultValue={s?.requiredResourceType ?? ""}
                  className={`${input} mt-1 block`}
                >
                  <option value="">nothing</option>
                  {TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex items-center gap-1 pb-1">
                <input type="checkbox" name="active" defaultChecked={s?.active ?? true} /> active
              </label>
              <button className={s ? buttonSecondary : button}>{s ? "Save" : "Add service"}</button>
              {s && (
                <span className="basis-full text-xs text-zinc-500">
                  Performed by:{" "}
                  {staff
                    .filter((x) => x.active)
                    .map((x) => {
                      const on = s.staff.some((y) => y.staffId === x.id);
                      return (
                        <button
                          key={x.id}
                          formAction={toggleServiceStaffAction}
                          name="staffId"
                          value={x.id}
                          className={`mr-1 rounded border px-1.5 ${on ? "" : "line-through opacity-40"}`}
                        >
                          <input type="hidden" name="serviceId" value={s.id} />
                          {x.name}
                        </button>
                      );
                    })}
                </span>
              )}
            </form>
          ))}
        </div>
      </section>

      <div className="grid gap-6 md:grid-cols-2">
        <section className={card}>
          <h2 className="mb-2 font-medium">Staff</h2>
          <ul className="space-y-1 text-sm">
            {staff.map((s) => (
              <li key={s.id} className="flex items-center gap-2">
                <span className={s.active ? "" : "text-zinc-500 line-through"}>{s.name}</span>
                <form action={toggleStaffAction} className="ml-auto">
                  <input type="hidden" name="id" value={s.id} />
                  <button className="text-xs underline">
                    {s.active ? "deactivate" : "activate"}
                  </button>
                </form>
              </li>
            ))}
          </ul>
          <form action={createStaffAction} className="mt-3 flex gap-2 text-sm">
            <input name="name" placeholder="New staff name" required className={input} />
            <button className={buttonSecondary}>Add</button>
          </form>
        </section>

        <section className={card}>
          <h2 className="mb-2 font-medium">Resources</h2>
          <ul className="space-y-1 text-sm">
            {resources.map((r) => (
              <li key={r.id} className="flex items-center gap-2">
                <span className={r.active ? "" : "text-zinc-500 line-through"}>{r.name}</span>
                <span className="text-xs text-zinc-500">{r.type}</span>
                <form action={toggleResourceAction} className="ml-auto">
                  <input type="hidden" name="id" value={r.id} />
                  <button className="text-xs underline">
                    {r.active ? "deactivate" : "activate"}
                  </button>
                </form>
              </li>
            ))}
          </ul>
          <form action={createResourceAction} className="mt-3 flex gap-2 text-sm">
            <input name="name" placeholder="Chair 3" required className={input} />
            <select name="type" className={input}>
              {TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <button className={buttonSecondary}>Add</button>
          </form>
        </section>
      </div>
    </>
  );
}
