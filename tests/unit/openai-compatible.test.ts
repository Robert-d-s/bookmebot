import { describe, expect, it } from "vitest";
import {
  OpenAiCompatibleLlm,
  fromCompletion,
  toChatMessages,
} from "@/server/conversation/llm/openai-compatible";

describe("openai-compatible mapping", () => {
  it("flattens system + context and maps tool turns", () => {
    const msgs = toChatMessages({
      system: "SYS",
      context: "today=2026-09-12",
      tools: [],
      turns: [
        { role: "user", text: "hi" },
        {
          role: "assistant",
          text: null,
          toolCalls: [{ id: "c1", name: "list_services", input: {} }],
        },
        { role: "tool", results: [{ id: "c1", name: "list_services", output: { services: [] } }] },
        { role: "assistant", text: "Our services:", toolCalls: [] },
      ],
    });
    expect(msgs[0]).toEqual({ role: "system", content: "SYS\n\ntoday=2026-09-12" });
    expect(msgs[2]).toMatchObject({
      role: "assistant",
      tool_calls: [{ id: "c1", function: { name: "list_services", arguments: "{}" } }],
    });
    expect(msgs[3]).toEqual({ role: "tool", tool_call_id: "c1", content: '{"services":[]}' });
    expect(msgs[4]).toEqual({ role: "assistant", content: "Our services:" });
  });

  it("parses tool calls with JSON-string arguments, tolerates bad JSON", () => {
    const r = fromCompletion({
      choices: [
        {
          message: {
            content: "",
            tool_calls: [
              {
                id: "x",
                type: "function",
                function: {
                  name: "get_availability",
                  arguments: '{"service_id":"s","date":"2026-09-15"}',
                },
              },
              {
                id: "y",
                type: "function",
                function: { name: "list_services", arguments: "not json" },
              },
            ],
          },
        },
      ],
    });
    expect(r.stop).toBe("tool");
    expect(r.toolCalls[0].input).toEqual({ service_id: "s", date: "2026-09-15" });
    expect(r.toolCalls[1].input).toEqual({});
    expect(fromCompletion({ choices: [{ message: { content: "hello" } }] })).toEqual({
      text: "hello",
      toolCalls: [],
      stop: "end",
    });
  });

  it("posts to <base>/chat/completions with the bearer key and function tools", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
        status: 200,
      });
    }) as typeof fetch;
    const llm = new OpenAiCompatibleLlm({
      baseUrl: "https://api.groq.com/openai/v1/",
      apiKey: "K",
      model: "m",
      fetch: fakeFetch,
    });
    const r = await llm.complete({
      system: "s",
      context: "c",
      tools: [{ name: "t", description: "d", inputSchema: { type: "object", properties: {} } }],
      turns: [{ role: "user", text: "hi" }],
    });
    expect(r.text).toBe("ok");
    expect(calls[0].url).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe("Bearer K");
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.tools[0]).toEqual({
      type: "function",
      function: { name: "t", description: "d", parameters: { type: "object", properties: {} } },
    });
    expect(body.model).toBe("m");
  });

  it("surfaces HTTP errors", async () => {
    const fakeFetch = (async () => new Response("rate limited", { status: 429 })) as typeof fetch;
    const llm = new OpenAiCompatibleLlm({ baseUrl: "http://x", model: "m", fetch: fakeFetch });
    await expect(
      llm.complete({ system: "", context: "", tools: [], turns: [{ role: "user", text: "hi" }] }),
    ).rejects.toMatchObject({ status: 429 });
  });
});
