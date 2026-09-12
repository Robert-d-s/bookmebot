import Anthropic from "@anthropic-ai/sdk";
import { env } from "@/env";
import type { LlmClient, LlmRequest, LlmResponse, Turn } from "./types";

/**
 * Claude through the official SDK. Manual loop (not the beta tool runner)
 * because the loop lives in agent.ts and is shared with the scripted client.
 */
export function toMessages(turns: Turn[]): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];
  for (const t of turns) {
    if (t.role === "user") {
      out.push({ role: "user", content: t.text });
    } else if (t.role === "assistant") {
      const content: Anthropic.ContentBlockParam[] = [];
      if (t.text) content.push({ type: "text", text: t.text });
      for (const c of t.toolCalls) {
        content.push({ type: "tool_use", id: c.id, name: c.name, input: c.input });
      }
      if (content.length === 0) content.push({ type: "text", text: "…" });
      out.push({ role: "assistant", content });
    } else {
      out.push({
        role: "user",
        content: t.results.map((r): Anthropic.ToolResultBlockParam => ({
          type: "tool_result",
          tool_use_id: r.id,
          content: JSON.stringify(r.output),
          is_error: r.isError,
        })),
      });
    }
  }
  return out;
}

export function fromResponse(msg: Anthropic.Message): LlmResponse {
  if (msg.stop_reason === "refusal") {
    return { text: "Sorry, I can't help with that.", toolCalls: [], stop: "refusal" };
  }
  const text = msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
  const toolCalls = msg.content
    .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
    .map((b) => ({ id: b.id, name: b.name, input: b.input as Record<string, unknown> }));
  return { text: text || null, toolCalls, stop: toolCalls.length ? "tool" : "end" };
}

export class AnthropicLlm implements LlmClient {
  readonly name = "anthropic";
  constructor(
    private readonly client: Anthropic = new Anthropic(),
    private readonly model: string = env.LLM_MODEL,
  ) {}

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 2048,
      system: [
        { type: "text", text: req.system, cache_control: { type: "ephemeral" } },
        { type: "text", text: req.context },
      ],
      tools: req.tools.map((t): Anthropic.Tool => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema as Anthropic.Tool["input_schema"],
      })),
      messages: toMessages(req.turns),
      output_config: { effort: "low" },
    });
    return fromResponse(response);
  }
}
