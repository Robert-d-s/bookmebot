import NextAuth from "next-auth";
import type { NextFetchEvent, NextRequest } from "next/server";
import { authConfig } from "@/server/auth/config";

/**
 * Route protection. Uses the database-free config so this can run before
 * any route without pulling Prisma into the proxy bundle; the `authorized`
 * callback decides, and Auth.js redirects to /login on false.
 *
 * Next's static check requires a function export named `proxy` (or default),
 * so the Auth.js handler is wrapped rather than re-exported.
 */
const { auth } = NextAuth(authConfig);
// auth(fn) returns a NextMiddleware that runs `authorized` first, then fn.
// The parameter types pick the middleware overload over the route-handler one.
const withAuth = auth((_request: NextRequest, _event: NextFetchEvent): undefined => undefined);

export function proxy(request: NextRequest, event: NextFetchEvent) {
  return withAuth(request, event);
}

export const config = {
  matcher: ["/dashboard/:path*"],
};
