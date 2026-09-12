import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/server/db/prisma";
import { getProvider } from "./registry";

/**
 * Step 1 of the pipeline: persist, then acknowledge. Nothing here runs a
 * handler. The result tells the route what status to answer with and which
 * new event ids are worth processing right away.
 */

export type IngestResult =
  | { status: 404; error: "UNKNOWN_PROVIDER" }
  | { status: 401; error: "BAD_SIGNATURE"; deliveryId: string }
  | { status: 400; error: "MALFORMED"; deliveryId: string; message: string }
  | { status: 200; deliveryId: string; newEventIds: string[]; duplicateCount: number };

export async function ingest(
  providerName: string,
  rawBody: string,
  headers: Headers,
): Promise<IngestResult> {
  const provider = getProvider(providerName);
  if (!provider) return { status: 404, error: "UNKNOWN_PROVIDER" };

  const signatureValid = provider.verify(rawBody, headers);

  // Raw delivery first, whatever happens next. A rejected signature is still
  // worth keeping: it is either an attack or a misconfigured secret.
  const delivery = await prisma.webhookDelivery.create({
    data: {
      provider: provider.name,
      rawBody,
      headers: headersToJson(headers),
      signatureValid,
    },
    select: { id: true },
  });
  if (!signatureValid) return { status: 401, error: "BAD_SIGNATURE", deliveryId: delivery.id };

  let parsed;
  try {
    parsed = provider.parse(rawBody);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { status: 400, error: "MALFORMED", deliveryId: delivery.id, message };
  }

  // Idempotency: (provider, providerEventId) is unique. createMany with
  // skipDuplicates makes a redelivery a no-op at the database, not in code.
  const rows: Prisma.InboundEventCreateManyInput[] = parsed.map((e) => ({
    deliveryId: delivery.id,
    provider: provider.name,
    providerEventId: e.providerEventId,
    eventType: e.eventType,
    correlationKey: e.correlationKey,
    payload: e.payload as Prisma.InputJsonValue,
  }));
  const { count } = await prisma.inboundEvent.createMany({ data: rows, skipDuplicates: true });

  const newEvents = await prisma.inboundEvent.findMany({
    where: { deliveryId: delivery.id },
    select: { id: true },
    orderBy: { receivedAt: "asc" },
  });
  return {
    status: 200,
    deliveryId: delivery.id,
    newEventIds: newEvents.map((e) => e.id),
    duplicateCount: parsed.length - count,
  };
}

const KEEP_HEADERS = ["content-type", "user-agent", "x-signature", "x-hub-signature-256"];

/** Only headers useful for debugging; never authorization or cookies. */
function headersToJson(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of KEEP_HEADERS) {
    const v = headers.get(name);
    if (v) out[name] = v;
  }
  return out;
}
