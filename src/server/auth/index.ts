import { compare } from "bcryptjs";
import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { z } from "zod";
import { prisma } from "@/server/db/prisma";
import { authConfig } from "./config";
import { verifyMagicToken } from "./magic";

/**
 * Auth.js v5. Credentials (email + bcrypt password) against the users table,
 * JWT sessions. Chosen over OAuth/magic links because it needs no third-party
 * account and the demo has exactly one owner; the provider list is the only
 * thing to change for GitHub/Google login.
 */
const credentials = z.union([
  z.object({ email: z.string().email(), password: z.string().min(1) }),
  z.object({ magicToken: z.string().min(1) }),
]);

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  providers: [
    Credentials({
      credentials: {
        email: { type: "email" },
        password: { type: "password" },
        magicToken: { type: "text" },
      },
      async authorize(raw) {
        const parsed = credentials.safeParse(raw);
        if (!parsed.success) return null;
        // Either a password or a signed sign-in link token (see ./magic.ts).
        const email =
          "magicToken" in parsed.data
            ? verifyMagicToken(parsed.data.magicToken)
            : parsed.data.email.toLowerCase();
        if (!email) return null;
        const user = await prisma.user.findUnique({ where: { email } });
        if (!user) return null;
        if ("password" in parsed.data) {
          const ok = await compare(parsed.data.password, user.passwordHash);
          if (!ok) return null;
        }
        return {
          id: user.id,
          email: user.email,
          name: user.name,
          businessId: user.businessId,
          role: user.role,
        };
      },
    }),
  ],
});
