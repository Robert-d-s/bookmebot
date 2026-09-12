import type { Channel } from "@/generated/prisma/client";
import type { OutboundMessage } from "@/server/channels/types";
import { prisma } from "@/server/db/prisma";
import { buttonsFromResults, compose } from "./buttons";
import { getLlm } from "./llm";
import type { ToolResult, Turn } from "./llm/types";
import { buildContext, buildSystem } from "./prompt";
import { loadConversation, saveConversation } from "./state";
import { TOOL_DEFS, ToolError, executeTool } from "./tools";

/**
 * One customer message in, zero or more outbound messages out. The loop is
 * the same for every LlmClient; only `complete()` differs.
 */
export interface AgentArgs {
  businessId: string;
  customer: { id: string; name: string | null };
  channel: Channel;
  userText: string;
  now?: Date;
}

const MAX_STEPS = 6;

export async function runAgent(args: AgentArgs): Promise<OutboundMessage[]> {
  const now = args.now ?? new Date();
  const conv = await loadConversation(args.businessId, args.customer.id);
  if (conv.mode === "HUMAN") return [];

  const business = await prisma.business.findUniqueOrThrow({
    where: { id: args.businessId },
    select: { timezone: true },
  });
  const [system, context] = await Promise.all([
    buildSystem(args.businessId),
    buildContext({
      businessId: args.businessId,
      customer: args.customer,
      timezone: business.timezone,
      now,
    }),
  ]);

  const state = { ...conv.state, turn: conv.state.turn + 1 };
  const turns: Turn[] = [...conv.turns, { role: "user", text: args.userText }];
  const toolCtx = {
    businessId: args.businessId,
    customer: args.customer,
    channel: args.channel,
    timezone: business.timezone,
    state,
    now,
  };
  const llm = getLlm();

  let text: string | null = null;
  let quickReplies: { id: string; title: string }[] | undefined;
  const results: ToolResult[] = [];

  for (let step = 0; step < MAX_STEPS; step++) {
    const res = await llm.complete({ system, context, tools: TOOL_DEFS, turns });
    turns.push({ role: "assistant", text: res.text, toolCalls: res.toolCalls });
    text = res.text ?? text;
    quickReplies = res.quickReplies ?? quickReplies;
    if (res.toolCalls.length === 0) break;

    const batch: ToolResult[] = [];
    for (const call of res.toolCalls) {
      try {
        batch.push({
          id: call.id,
          name: call.name,
          output: await executeTool(call.name, call.input, toolCtx),
        });
      } catch (err) {
        if (!(err instanceof ToolError)) throw err;
        batch.push({ id: call.id, name: call.name, output: { error: err.message }, isError: true });
      }
    }
    turns.push({ role: "tool", results: batch });
    results.push(...batch);
    text = null; // a tool turn supersedes any interim text
  }

  await saveConversation(conv.id, turns, state);

  const derived = buttonsFromResults(results);
  const opts =
    derived.buttons?.length || derived.rows?.length ? derived : { buttons: quickReplies };
  return compose(text ?? "Sorry, I lost my train of thought. Could you say that again?", opts);
}
