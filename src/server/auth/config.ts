import type { NextAuthConfig } from "next-auth";

/**
 * The part of the Auth.js config that is safe to import from the proxy:
 * no database, no bcrypt. `auth.ts` extends it with the Credentials provider.
 */
export const authConfig = {
  session: { strategy: "jwt" },
  pages: { signIn: "/login" },
  trustHost: true,
  providers: [],
  callbacks: {
    authorized({ auth, request }) {
      const protectedPath = request.nextUrl.pathname.startsWith("/dashboard");
      return protectedPath ? Boolean(auth?.user) : true;
    },
    jwt({ token, user }) {
      if (user) {
        token.businessId = user.businessId;
        token.role = user.role;
      }
      return token;
    },
    session({ session, token }) {
      session.user.id = token.sub ?? "";
      // The JWT type augmentation lives in next-auth/jwt, but callbacks are
      // typed against @auth/core's JWT, so narrow here.
      session.user.businessId = String(token.businessId ?? "");
      session.user.role = String(token.role ?? "");
      return session;
    },
  },
} satisfies NextAuthConfig;
