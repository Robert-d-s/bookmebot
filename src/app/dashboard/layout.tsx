import Link from "next/link";
import { requireUser } from "@/server/auth/session";
import { getBusiness } from "@/server/dashboard/queries";
import { logoutAction } from "../login/actions";

const NAV = [
  ["/dashboard", "Schedule"],
  ["/dashboard/bookings/new", "New booking"],
  ["/dashboard/customers", "Customers"],
  ["/dashboard/simulator", "Simulator"],
  ["/dashboard/calendar", "Calendar"],
  ["/dashboard/settings", "Settings"],
  ["/dashboard/events", "Events"],
] as const;

export default async function DashboardLayout({ children }: LayoutProps<"/dashboard">) {
  const user = await requireUser();
  const business = await getBusiness(user.businessId);
  return (
    <div className="flex flex-1 flex-col">
      <header className="flex flex-wrap items-center gap-4 border-b px-6 py-3">
        <span className="font-semibold">{business.name}</span>
        <nav className="flex flex-wrap gap-3 text-sm">
          {NAV.map(([href, label]) => (
            <Link key={href} href={href} className="hover:underline">
              {label}
            </Link>
          ))}
        </nav>
        <form action={logoutAction} className="ml-auto text-sm">
          <span className="mr-3 text-zinc-500">{user.email}</span>
          <button className="underline">Sign out</button>
        </form>
      </header>
      <main className="flex-1 space-y-6 p-6">{children}</main>
    </div>
  );
}
