"use server";

import { AuthError } from "next-auth";
import { redirect } from "next/navigation";
import { signIn, signOut } from "@/server/auth";

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
