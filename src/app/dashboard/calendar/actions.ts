"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireUser } from "@/server/auth/session";
import { fakeCalendar } from "@/server/calendar/api";
import {
  connectDemo,
  disconnect,
  getConnection,
  pullBlocks,
  syncCalendars,
} from "@/server/calendar/sync";
import { prisma } from "@/server/db/prisma";
import { localMinutesToUtc, type LocalDate } from "@/server/scheduling/time";

const back = (q: string): never => redirect(`/dashboard/calendar?${q}`);

export async function connectDemoCalendarAction() {
  const user = await requireUser();
  await connectDemo(user.businessId);
  revalidatePath("/dashboard/calendar");
  back("ok=Demo+calendar+connected");
}

export async function disconnectCalendarAction() {
  const user = await requireUser();
  await disconnect(user.businessId);
  revalidatePath("/dashboard/calendar");
  back("ok=Disconnected");
}

export async function syncNowAction() {
  await requireUser();
  const r = await syncCalendars();
  revalidatePath("/dashboard/calendar");
  back(
    `ok=${encodeURIComponent(`Pushed ${r.pushed}, failed ${r.failed}, pulled ${r.pulled.upserted} blocks`)}`,
  );
}

/** Demo only: pretend the owner created an event in Google, then pull it. */
export async function addForeignBlockAction(formData: FormData) {
  const user = await requireUser();
  const conn = await getConnection(user.businessId);
  if (!conn || conn.provider !== "fake") back("error=Demo+calendar+not+connected");
  const business = await prisma.business.findUniqueOrThrow({
    where: { id: user.businessId },
    select: { timezone: true },
  });
  const input = z
    .object({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      start: z.string().regex(/^\d{2}:\d{2}$/),
      minutes: z.coerce
        .number()
        .int()
        .min(15)
        .max(24 * 60),
      summary: z.string().max(100).optional(),
    })
    .parse({
      date: String(formData.get("date") ?? ""),
      start: String(formData.get("start") ?? ""),
      minutes: String(formData.get("minutes") ?? "60"),
      summary: String(formData.get("summary") ?? "") || undefined,
    });
  const [h, m] = input.start.split(":").map(Number);
  const start = localMinutesToUtc(input.date as LocalDate, h * 60 + m, business.timezone);
  fakeCalendar.addForeign(conn!, {
    start,
    end: new Date(start.getTime() + input.minutes * 60_000),
    summary: input.summary ?? "Blocked in Google",
  });
  await pullBlocks(conn!.id);
  revalidatePath("/dashboard/calendar");
  revalidatePath("/dashboard");
  back("ok=Block+added+in+the+demo+calendar+and+pulled");
}

export async function removeForeignBlockAction(formData: FormData) {
  const user = await requireUser();
  const conn = await getConnection(user.businessId);
  if (!conn || conn.provider !== "fake") back("error=Demo+calendar+not+connected");
  fakeCalendar.cancelForeign(conn!, String(formData.get("externalEventId") ?? ""));
  await pullBlocks(conn!.id);
  revalidatePath("/dashboard/calendar");
  back("ok=Block+removed+and+pulled");
}
