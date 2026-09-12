import { env } from "@/env";
import type { LlmClient, LlmRequest, LlmResponse, Turn } from "./types";

/**
 * Any provider that speaks the OpenAI chat-completions wire format with
 * function calling. That covers the zero-spend options:
 *   Groq free tier        https://api.groq.com/openai/v1
 *   Google AI Studio      https://generativelanguage.googleapis.com/v1beta/openai
 *   OpenRouter :free      https://openrouter.ai/api/v1
 *   Ollama (local)        http://localhost:11434/v1
 * Plain fetch, no SDK: the shape is small and stable.
 */

type Msg =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCallWire[] }
  | { role: "tool"; tool_call_id: string; content: string };

interface ToolCallWire {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface Completion {
  choices: {
    message: { content: string | null; tool_calls?: ToolCallWire[] };
    finish_reason?: string;
  }[];
}

export function toChatMessages(req: LlmRequest): Msg[] {
  const out: Msg[] = [{ role: "system", content: `${req.system}\n\n${req.context}` }];
  for (const t of req.turns as Turn[]) {
    if (t.role === "user") out.push({ role: "user", content: t.text });
    else if (t.role === "assistant") {
      out.push({
        role: "assistant",
        content: t.text,
        ...(t.toolCalls.length
          ? {
              tool_calls: t.toolCalls.map((c) => ({
                id: c.id,
                type: "function" as const,
                function: { name: c.name, arguments: JSON.stringify(c.input) },
              })),
            }
          : {}),
      });
    } else {
      for (const r of t.results) {
        out.push({ role: "tool", tool_call_id: r.id, content: JSON.stringify(r.output) });
      }
    }
  }
  return out;
}

export function fromCompletion(c: Completion): LlmResponse {
  const m = c.choices[0]?.message;
  if (!m) return { text: null, toolCalls: [], stop: "end" };
  const toolCalls = (m.tool_calls ?? []).map((tc) => ({
    id: tc.id,
    name: tc.function.name,
    input: parseArgs(tc.function.arguments),
  }));
  const text = m.content?.trim() || null;
  return { text, toolCalls, stop: toolCalls.length ? "tool" : "end" };
}

function parseArgs(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s || "{}");
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export class OpenAiCompatibleError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`LLM API ${status}: ${body.slice(0, 200)}`);
    this.name = "OpenAiCompatibleError";
  }
}

export interface OpenAiCompatibleOptions {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  fetch?: typeof fetch;
}

export class OpenAiCompatibleLlm implements LlmClient {
  readonly name = "openai-compatible";
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly model: string;
  private readonly doFetch: typeof fetch;

  constructor(opts: OpenAiCompatibleOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? env.LLM_BASE_URL ?? "").replace(/\/$/, "");
    this.apiKey = opts.apiKey ?? env.LLM_API_KEY;
    this.model = opts.model ?? env.LLM_MODEL;
    this.doFetch = opts.fetch ?? fetch;
    if (!this.baseUrl)
      throw new Error("LLM_BASE_URL is required for LLM_PROVIDER=openai-compatible");
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const res = await this.doFetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: this.model,
        messages: toChatMessages(req),
        tools: req.tools.map((t) => ({
          type: "function",
          function: { name: t.name, description: t.description, parameters: t.inputSchema },
        })),
        tool_choice: "auto",
        temperature: 0.2,
      }),
    });
    const body = await res.text();
    if (!res.ok) throw new OpenAiCompatibleError(res.status, body);
    return fromCompletion(JSON.parse(body) as Completion);
  }
}
