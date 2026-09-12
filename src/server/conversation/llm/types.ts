/**
 * Provider-neutral shapes for the conversation loop. The transcript is stored
 * in this format, so switching providers never invalidates history.
 */

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResult {
  id: string;
  name: string;
  output: unknown;
  isError?: boolean;
}

export type Turn =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string | null; toolCalls: ToolCall[] }
  | { role: "tool"; results: ToolResult[] };

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface LlmRequest {
  /** Stable per business: cacheable. */
  system: string;
  /** Volatile: date, customer, upcoming bookings. */
  context: string;
  tools: ToolDef[];
  turns: Turn[];
}

export interface QuickReply {
  id: string;
  title: string;
}

export interface LlmResponse {
  text: string | null;
  toolCalls: ToolCall[];
  /** Buttons the model wants to offer when no tool result implies any. */
  quickReplies?: QuickReply[];
  stop: "end" | "tool" | "refusal";
}

export interface LlmClient {
  name: string;
  complete(req: LlmRequest): Promise<LlmResponse>;
}
