import type { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface User {
    businessId: string;
    role: string;
  }
  interface Session {
    user: { id: string; businessId: string; role: string } & DefaultSession["user"];
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    businessId: string;
    role: string;
  }
}
