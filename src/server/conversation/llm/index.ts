import { env } from "@/env";
import { AnthropicLlm } from "./anthropic";
import { ScriptedLlm } from "./scripted";
import type { LlmClient } from "./types";

let override: LlmClient | undefined;

/** Which brain answers: env-driven, overridable by tests. */
export function getLlm(): LlmClient {
  if (override) return override;
  const provider = env.LLM_PROVIDER ?? (env.ANTHROPIC_API_KEY ? "anthropic" : "scripted");
  return provider === "anthropic" ? new AnthropicLlm() : new ScriptedLlm();
}

export function setLlm(client: LlmClient | undefined) {
  override = client;
}

export type {
  LlmClient,
  LlmRequest,
  LlmResponse,
  ToolCall,
  ToolDef,
  ToolResult,
  Turn,
} from "./types";
