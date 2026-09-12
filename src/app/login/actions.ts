"use server";

import { AuthError } from "next-auth";
import { redirect } from "next/navigation";
import { signIn, signOut } from "@/server/auth";
import { sendMagicLink } from "@/server/auth/magic";

export async function loginAction(formData: FormData) {
  try {
    await signIn("credentials", {
      email: String(formData.get("email") ?? "").toLowerCase(),
      password: String(formData.get("password") ?? ""),
      redirectTo: "/dashboard",
    });
  } catch (err) {
    // signIn signals success by throwing a redirect; only auth failures are ours.
    if (err instanceof AuthError) redirect("/login?error=1");
    throw err;
  }
}

export async function logoutAction() {
  await signOut({ redirectTo: "/login" });
}

/** "Email me a sign-in link". Always lands on the same page, so addresses cannot be probed. */
export async function magicLinkAction(formData: FormData) {
  const email = String(formData.get("email") ?? "")
    .trim()
    .toLowerCase();
  if (email) await sendMagicLink(email).catch(() => {});
  redirect("/login?sent=1");
}

/** The button on /auth/magic: exchange the link token for a session. */
export async function magicSignInAction(formData: FormData) {
  try {
    await signIn("credentials", {
      magicToken: String(formData.get("token") ?? ""),
      redirectTo: "/dashboard",
    });
  } catch (err) {
    if (err instanceof AuthError) redirect("/login?error=expired");
    throw err;
  }
}
