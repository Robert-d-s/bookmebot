import { describe, expect, it } from "vitest";
import { authConfig } from "@/server/auth/config";

/** The `authorized` callback is the whole proxy decision; pin its behaviour. */
const authorized = authConfig.callbacks.authorized;
const req = (path: string) =>
  ({ nextUrl: new URL(`http://localhost${path}`) }) as unknown as Parameters<
    typeof authorized
  >[0]["request"];
const session = { user: { id: "u", businessId: "b", role: "OWNER" }, expires: "" };

describe("authorized", () => {
  it("requires a session under /dashboard", () => {
    expect(authorized({ auth: null, request: req("/dashboard") })).toBe(false);
    expect(authorized({ auth: null, request: req("/dashboard/settings") })).toBe(false);
    expect(authorized({ auth: session, request: req("/dashboard/settings") })).toBe(true);
  });
  it("leaves everything else alone", () => {
    expect(authorized({ auth: null, request: req("/") })).toBe(true);
    expect(authorized({ auth: null, request: req("/api/webhooks/simulator") })).toBe(true);
  });
});
