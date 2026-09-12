import { randomUUID } from "node:crypto";
import { env } from "@/env";
import { prisma } from "@/server/db/prisma";

/**
 * The slice of the Google Calendar API v3 we use, behind an interface with an
 * in-memory fake. `private` is Google's extendedProperties.private, where we
 * tag our own events so the pull side can recognise and skip them.
 */
export interface Conn {
  id: string;
  calendarId: string;
  accessToken: string | null;
  refreshToken: string | null;
  expiresAt: Date | null;
}

export interface CalendarEventInput {
  summary: string;
  description?: string;
  start: Date;
  end: Date;
  timeZone: string;
  bookingId: string;
}

export interface ExternalEvent {
  id: string;
  status: "confirmed" | "tentative" | "cancelled";
  summary?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  private?: Record<string, string>;
}

export interface ListArgs {
  timeMin?: Date;
  timeMax?: Date;
  syncToken?: string;
}

export interface ListResult {
  events: ExternalEvent[];
  nextSyncToken?: string;
}

export class SyncTokenExpired extends Error {}
export class EventNotFound extends Error {}

export interface CalendarApi {
  insert(conn: Conn, ev: CalendarEventInput): Promise<string>;
  update(conn: Conn, eventId: string, ev: CalendarEventInput): Promise<void>;
  remove(conn: Conn, eventId: string): Promise<void>;
  list(conn: Conn, args: ListArgs): Promise<ListResult>;
}

export const OUR_TAG = { bookmebot: "1" };

function toGoogleBody(ev: CalendarEventInput) {
  return {
    summary: ev.summary,
    description: ev.description,
    start: { dateTime: ev.start.toISOString(), timeZone: ev.timeZone },
    end: { dateTime: ev.end.toISOString(), timeZone: ev.timeZone },
    extendedProperties: { private: { ...OUR_TAG, bookingId: ev.bookingId } },
  };
}

// --- Google -------------------------------------------------------------------

const BASE = "https://www.googleapis.com/calendar/v3";

export class GoogleCalendarApi implements CalendarApi {
  constructor(private readonly doFetch: typeof fetch = fetch) {}

  /** A valid access token, refreshing (and persisting) when within a minute of expiry. */
  private async token(conn: Conn): Promise<string> {
    if (conn.accessToken && conn.expiresAt && conn.expiresAt.getTime() - Date.now() > 60_000) {
      return conn.accessToken;
    }
    if (!conn.refreshToken) throw new Error("calendar connection has no refresh token");
    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET)
      throw new Error("Google OAuth is not configured");
    const res = await this.doFetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: conn.refreshToken,
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
      }),
    });
    if (!res.ok) throw new Error(`token refresh failed: ${res.status} ${await res.text()}`);
    const json = (await res.json()) as { access_token: string; expires_in: number };
    const expiresAt = new Date(Date.now() + json.expires_in * 1000);
    await prisma.calendarConnection.update({
      where: { id: conn.id },
      data: { accessToken: json.access_token, expiresAt },
    });
    conn.accessToken = json.access_token;
    conn.expiresAt = expiresAt;
    return json.access_token;
  }

  private async call(
    conn: Conn,
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string>,
  ) {
    const url = new URL(`${BASE}/calendars/${encodeURIComponent(conn.calendarId)}${path}`);
    for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
    const res = await this.doFetch(url, {
      method,
      headers: {
        authorization: `Bearer ${await this.token(conn)}`,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 404) throw new EventNotFound(path);
    if (res.status === 410) throw new SyncTokenExpired();
    if (!res.ok)
      throw new Error(
        `Google Calendar ${method} ${path}: ${res.status} ${(await res.text()).slice(0, 200)}`,
      );
    return res.status === 204 ? null : res.json();
  }

  async insert(conn: Conn, ev: CalendarEventInput) {
    const json = (await this.call(conn, "POST", "/events", toGoogleBody(ev))) as { id: string };
    return json.id;
  }
  async update(conn: Conn, eventId: string, ev: CalendarEventInput) {
    await this.call(conn, "PATCH", `/events/${encodeURIComponent(eventId)}`, toGoogleBody(ev));
  }
  async remove(conn: Conn, eventId: string) {
    try {
      await this.call(conn, "DELETE", `/events/${encodeURIComponent(eventId)}`);
    } catch (err) {
      if (!(err instanceof EventNotFound)) throw err; // already gone is fine
    }
  }
  async list(conn: Conn, args: ListArgs) {
    const events: ExternalEvent[] = [];
    let pageToken: string | undefined;
    let nextSyncToken: string | undefined;
    do {
      const query: Record<string, string> = {
        singleEvents: "true",
        maxResults: "250",
        showDeleted: "true",
      };
      if (args.syncToken) query.syncToken = args.syncToken;
      else {
        if (args.timeMin) query.timeMin = args.timeMin.toISOString();
        if (args.timeMax) query.timeMax = args.timeMax.toISOString();
      }
      if (pageToken) query.pageToken = pageToken;
      const json = (await this.call(conn, "GET", "/events", undefined, query)) as {
        items?: (ExternalEvent & { extendedProperties?: { private?: Record<string, string> } })[];
        nextPageToken?: string;
        nextSyncToken?: string;
      };
      for (const it of json.items ?? []) {
        events.push({
          id: it.id,
          status: it.status,
          summary: it.summary,
          start: it.start,
          end: it.end,
          private: it.extendedProperties?.private,
        });
      }
      pageToken = json.nextPageToken;
      nextSyncToken = json.nextSyncToken ?? nextSyncToken;
    } while (pageToken);
    return { events, nextSyncToken };
  }
}

// --- Fake ---------------------------------------------------------------------

type Stored = ExternalEvent & { version: number };

/**
 * In-memory calendar with Google's incremental-sync semantics: a sync token is
 * a version watermark; listing with it returns events changed since, including
 * cancellations; `expireTokens()` makes the next incremental call fail with
 * 410 like Google does after a while.
 */
export class FakeCalendarApi implements CalendarApi {
  private calendars = new Map<string, Map<string, Stored>>();
  private clock = 0;
  private minValidToken = 0;

  private cal(conn: Conn) {
    let c = this.calendars.get(conn.id);
    if (!c) this.calendars.set(conn.id, (c = new Map()));
    return c;
  }
  async insert(conn: Conn, ev: CalendarEventInput) {
    const id = `fake_${randomUUID().slice(0, 8)}`;
    this.cal(conn).set(id, {
      id,
      status: "confirmed",
      summary: ev.summary,
      start: { dateTime: ev.start.toISOString() },
      end: { dateTime: ev.end.toISOString() },
      private: { ...OUR_TAG, bookingId: ev.bookingId },
      version: ++this.clock,
    });
    return id;
  }
  async update(conn: Conn, eventId: string, ev: CalendarEventInput) {
    const cur = this.cal(conn).get(eventId);
    if (!cur || cur.status === "cancelled") throw new EventNotFound(eventId);
    this.cal(conn).set(eventId, {
      ...cur,
      summary: ev.summary,
      start: { dateTime: ev.start.toISOString() },
      end: { dateTime: ev.end.toISOString() },
      version: ++this.clock,
    });
  }
  async remove(conn: Conn, eventId: string) {
    const cur = this.cal(conn).get(eventId);
    if (cur) this.cal(conn).set(eventId, { ...cur, status: "cancelled", version: ++this.clock });
  }
  async list(conn: Conn, args: ListArgs) {
    const all = [...this.cal(conn).values()];
    if (args.syncToken) {
      const since = Number(args.syncToken);
      if (since < this.minValidToken) throw new SyncTokenExpired();
      return {
        events: all.filter((e) => e.version > since).map(strip),
        nextSyncToken: String(this.clock),
      };
    }
    const inWindow = all.filter((e) => e.status !== "cancelled" && overlapsWindow(e, args));
    return { events: inWindow.map(strip), nextSyncToken: String(this.clock) };
  }

  // Test / demo helpers: what the owner does in Google's UI.
  addForeign(
    conn: Conn,
    ev:
      | { start: Date; end: Date; summary?: string }
      | { date: string; endDate: string; summary?: string },
  ) {
    const id = `foreign_${randomUUID().slice(0, 8)}`;
    const times =
      "date" in ev
        ? { start: { date: ev.date }, end: { date: ev.endDate } }
        : { start: { dateTime: ev.start.toISOString() }, end: { dateTime: ev.end.toISOString() } };
    this.cal(conn).set(id, {
      id,
      status: "confirmed",
      summary: ev.summary,
      ...times,
      version: ++this.clock,
    });
    return id;
  }
  cancelForeign(conn: Conn, id: string) {
    const cur = this.cal(conn).get(id);
    if (cur) this.cal(conn).set(id, { ...cur, status: "cancelled", version: ++this.clock });
  }
  expireTokens() {
    this.minValidToken = this.clock + 1;
  }
  get(conn: Conn, id: string) {
    return this.cal(conn).get(id);
  }
  count(conn: Conn) {
    return [...this.cal(conn).values()].filter((e) => e.status !== "cancelled").length;
  }
}

const strip = (e: Stored): ExternalEvent => {
  const { version, ...rest } = e;
  void version;
  return rest;
};
function overlapsWindow(e: Stored, a: ListArgs) {
  const s = e.start?.dateTime
    ? Date.parse(e.start.dateTime)
    : e.start?.date
      ? Date.parse(e.start.date)
      : 0;
  const en = e.end?.dateTime
    ? Date.parse(e.end.dateTime)
    : e.end?.date
      ? Date.parse(e.end.date)
      : s;
  return (!a.timeMax || s < a.timeMax.getTime()) && (!a.timeMin || en > a.timeMin.getTime());
}

// --- selection ----------------------------------------------------------------

const fake = new FakeCalendarApi();
let google: GoogleCalendarApi | undefined;

/** The fake is a process-wide singleton so the dashboard demo and tests share it. */
export function getCalendarApi(provider: string): CalendarApi {
  if (provider === "fake") return fake;
  return (google ??= new GoogleCalendarApi());
}
export const fakeCalendar = fake;
export const googleConfigured = () => Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
