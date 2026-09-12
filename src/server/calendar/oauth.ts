import { env } from "@/env";
import { hmacSha256Hex, safeEqual } from "@/server/webhooks/signature";

/** Google OAuth 2.0 web flow. State is the business id signed with AUTH_SECRET (CSRF). */
export const SCOPE = "https://www.googleapis.com/auth/calendar.events";
export const redirectUri = () => `${env.APP_URL}/api/integrations/google/callback`;

export function signState(businessId: string): string {
  return `${businessId}.${hmacSha256Hex(env.AUTH_SECRET, `google-state:${businessId}`)}`;
}
export function verifyState(state: string | null): string | null {
  if (!state) return null;
  const i = state.lastIndexOf(".");
  if (i < 0) return null;
  const businessId = state.slice(0, i);
  return safeEqual(state.slice(i + 1), hmacSha256Hex(env.AUTH_SECRET, `google-state:${businessId}`))
    ? businessId
    : null;
}

export function buildAuthUrl(businessId: string): string {
  if (!env.GOOGLE_CLIENT_ID) throw new Error("Google OAuth is not configured");
  const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  u.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
  u.searchParams.set("redirect_uri", redirectUri());
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", SCOPE);
  u.searchParams.set("access_type", "offline");
  u.searchParams.set("prompt", "consent");
  u.searchParams.set("state", signState(businessId));
  return u.toString();
}

export async function exchangeCode(code: string, doFetch: typeof fetch = fetch) {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET)
    throw new Error("Google OAuth is not configured");
  const res = await doFetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri(),
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) throw new Error(`code exchange failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? null,
    expiresAt: new Date(Date.now() + json.expires_in * 1000),
  };
}
