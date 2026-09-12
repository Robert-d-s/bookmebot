import Link from "next/link";
import { requireUser } from "@/server/auth/session";
import { getBusiness, getCatalog } from "@/server/dashboard/queries";
import { getAvailability } from "@/server/scheduling";
import { type LocalDate, toLocalDate } from "@/server/scheduling/time";
import { createBookingAction } from "../../actions";
import { Flash, button, buttonSecondary, card, input } from "../../_components/ui";
import { fmtTime } from "../../_lib/format";

const isUuid = (s: unknown): s is string => typeof s === "string" && /^[0-9a-f-]{36}$/i.test(s);
const isDate = (s: unknown): s is LocalDate =>
  typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

export default async function NewBookingPage(props: PageProps<"/dashboard/bookings/new">) {
  const user = await requireUser();
  const [business, { services, staff }] = await Promise.all([
    getBusiness(user.businessId),
    getCatalog(user.businessId),
  ]);
  const sp = await props.searchParams;
  const service = isUuid(sp.service) ? sp.service : "";
  const staffId = isUuid(sp.staff) ? sp.staff : "";
  const date = isDate(sp.date) ? sp.date : toLocalDate(new Date(), business.timezone);
  const start = typeof sp.start === "string" && !Number.isNaN(Date.parse(sp.start)) ? sp.start : "";

  const slots =
    service && date
      ? await getAvailability({
          businessId: user.businessId,
          serviceId: service,
          staffId: staffId || undefined,
          from: date,
          to: date,
        })
      : null;
  const chosen = services.find((s) => s.id === service);
  const staffName = (id: string) => staff.find((s) => s.id === id)?.name ?? id;

  return (
    <>
      <h1 className="text-xl font-semibold">New booking</h1>
      <Flash
        ok={typeof sp.ok === "string" ? sp.ok : undefined}
        error={typeof sp.error === "string" ? sp.error : undefined}
      />

      <form className={`${card} flex flex-wrap items-end gap-3`}>
        <label className="text-sm">
          Service
          <select name="service" defaultValue={service} required className={`${input} mt-1 block`}>
            <option value="">Choose…</option>
            {services
              .filter((s) => s.active)
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.durationMin} min)
                </option>
              ))}
          </select>
        </label>
        <label className="text-sm">
          Staff
          <select name="staff" defaultValue={staffId} className={`${input} mt-1 block`}>
            <option value="">Any available</option>
            {staff
              .filter((s) => s.active)
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
          </select>
        </label>
        <label className="text-sm">
          Date
          <input
            type="date"
            name="date"
            defaultValue={date}
            required
            className={`${input} mt-1 block`}
          />
        </label>
        <button className={button}>Show slots</button>
      </form>

      {slots && (
        <section className={card}>
          <h2 className="mb-2 font-medium">
            {chosen?.name} on {date}: {slots.length} slot{slots.length === 1 ? "" : "s"}
          </h2>
          {slots.length === 0 && (
            <p className="text-sm text-zinc-500">Nothing free. Try another day or staff member.</p>
          )}
          <div className="flex flex-wrap gap-2">
            {slots.map((s) => {
              const iso = s.start.toISOString();
              const href = `/dashboard/bookings/new?service=${service}&staff=${staffId}&date=${date}&start=${encodeURIComponent(iso)}`;
              return (
                <Link
                  key={iso}
                  href={href}
                  title={s.staffIds.map(staffName).join(", ")}
                  className={`${buttonSecondary} font-mono ${iso === start ? "ring-2 ring-zinc-500" : ""}`}
                >
                  {fmtTime(s.start, business.timezone)}
                </Link>
              );
            })}
          </div>
        </section>
      )}

      {start && chosen && (
        <form action={createBookingAction} className={`${card} space-y-3`}>
          <h2 className="font-medium">
            {chosen.name} at {fmtTime(new Date(start), business.timezone)} on {date}
            {staffId ? ` with ${staffName(staffId)}` : " with any available staff"}
          </h2>
          <input type="hidden" name="service" value={service} />
          <input type="hidden" name="staff" value={staffId} />
          <input type="hidden" name="date" value={date} />
          <input type="hidden" name="startsAt" value={start} />
          <div className="flex flex-wrap gap-3">
            <label className="text-sm">
              Phone (E.164)
              <input
                name="phone"
                required
                placeholder="+40721000000"
                className={`${input} mt-1 block`}
              />
            </label>
            <label className="text-sm">
              Name
              <input name="name" className={`${input} mt-1 block`} />
            </label>
            <label className="flex-1 text-sm">
              Notes
              <input name="notes" className={`${input} mt-1 block w-full`} />
            </label>
          </div>
          <button className={button}>Book it</button>
        </form>
      )}
    </>
  );
}
