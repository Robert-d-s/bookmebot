import { redirect } from "next/navigation";
import { auth } from "./index";

/** The signed-in owner, or a redirect to /login. Use at the top of every dashboard page and action. */
export async function requireUser() {
  const session = await auth();
  if (!session?.user?.businessId) redirect("/login");
  return session.user;
}
