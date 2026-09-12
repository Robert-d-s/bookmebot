"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { env } from "@/env";
import { requireUser } from "@/server/auth/session";
import { prisma } from "@/server/db/prisma";
import { hmacSha256Hex, ingest, processEvent } from "@/server/webhooks";

/**
 * Play the customer. The message goes through the real webhook layer as a
 * signed simulator delivery, so what you see in the chat is exactly what a
 * WhatsApp message would trigger: delivery row, event row, handler, replies.
 */
export async function sendAsCustomerAction(formData: FormData) {
  const user = await requireUser();
  const input = z
    .object({
      phone: z.string().regex(/^\+[1-9]\d{6,14}$/, "E.164 phone expected"),
      name: z.string().max(100).optional(),
      text: z.string().max(1000).optional(),
      replyId: z.string().optional(),
      replyTitle: z.string().optional(),
    })
    .parse({
      phone: String(formData.get("phone") ?? "").trim(),
      name: String(formData.get("name") ?? "").trim() || undefined,
      text: String(formData.get("text") ?? "").trim() || undefined,
      replyId: String(formData.get("replyId") ?? "") || undefined,
      replyTitle: String(formData.get("replyTitle") ?? "") || undefined,
    });
  const business = await prisma.business.findUniqueOrThrow({
    where: { id: user.businessId },
    select: { slug: true },
  });

  const data = {
    business: business.slug,
    from: input.phone,
    name: input.name,
    ...(input.replyId
      ? { reply: { id: input.replyId, title: input.replyTitle ?? input.replyId } }
      : { text: input.text ?? "" }),
  };
  const raw = JSON.stringify({
    events: [
      {
        id: `sim-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        type: "message.received",
        data,
      },
    ],
  });
  const headers = new Headers({
    "x-signature": `sha256=${hmacSha256Hex(env.WEBHOOK_SIMULATOR_SECRET, raw)}`,
  });
  const result = await ingest("simulator", raw, headers);
  if (result.status === 200) {
    for (const id of result.newEventIds) await processEvent(id);
  }
  redirect(`/dashboard/simulator?phone=${encodeURIComponent(input.phone)}`);
}
