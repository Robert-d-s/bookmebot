import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/server/db/prisma";
import type { Turn } from "./llm/types";

/**
 * What the guardrails need between messages. Kept tiny on purpose: the
 * transcript is the memory; this is just the bookkeeping the model must not
 * be able to forge.
 */
export interface Proposal {
  id: string;
  serviceId: string;
  staffId?: string;
  start: string; // ISO
  /** Customer turn number in which the proposal was made. */
  turn: number;
  createdAt: string; // ISO
}

export interface ConversationState {
  /** Increments once per customer message. */
  turn: number;
  proposal?: Proposal;
}

const MAX_TURNS = 40;

export async function loadConversation(businessId: string, customerId: string) {
  const row = await prisma.conversation.upsert({
    where: { customerId },
    create: { businessId, customerId },
    update: {},
  });
  return {
    id: row.id,
    mode: row.mode,
    turns: (row.transcript as unknown as Turn[]) ?? [],
    state: {
      turn: 0,
      ...(row.state as unknown as Partial<ConversationState>),
    } as ConversationState,
  };
}

export async function saveConversation(id: string, turns: Turn[], state: ConversationState) {
  // Trim from the front but never start on a tool-result turn.
  let kept = turns.slice(-MAX_TURNS);
  while (kept.length && kept[0].role !== "user") kept = kept.slice(1);
  await prisma.conversation.update({
    where: { id },
    data: {
      transcript: kept as unknown as Prisma.InputJsonValue,
      state: state as unknown as Prisma.InputJsonValue,
    },
  });
}

export async function setConversationMode(customerId: string, mode: "BOT" | "HUMAN") {
  await prisma.conversation.updateMany({ where: { customerId }, data: { mode } });
}
