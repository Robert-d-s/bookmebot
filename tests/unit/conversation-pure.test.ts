import { describe, expect, it } from "vitest";
import { buttonsFromResults, compose, decodeReply } from "@/server/conversation/buttons";
import { fromResponse, toMessages } from "@/server/conversation/llm/anthropic";
import { parseDate } from "@/server/conversation/llm/scripted";
import { spread } from "@/server/conversation/tools";
import type Anthropic from "@anthropic-ai/sdk";

describe("buttons", () => {
  it("decodes taps into sentences the model understands", () => {
    expect(decodeReply("slot:2026-09-15T07:00:00.000Z|svc|any", "Tue 10:00")).toBe(
      "slot pick: 2026-09-15T07:00:00.000Z service=svc staff=any (Tue 10:00)",
    );
    expect(decodeReply("confirm:ab12", "Yes")).toMatch(/^confirm:ab12 yes/);
    expect(decodeReply("menu:hours", "Opening hours")).toBe("What are your opening hours?");
    expect(decodeReply("weird", "Title")).toBe("Title");
  });

  it("derives buttons from tool results, later results win", () => {
    const r = buttonsFromResults([
      {
        id: "1",
        name: "list_services",
        output: { services: [{ id: "s", name: "Cut", durationMin: 30, price: "60 RON" }] },
      },
      { id: "2", name: "propose_booking", output: { proposal_id: "p1" } },
    ]);
    expect(r.buttons?.map((b) => b.id)).toEqual(["confirm:p1", "decline"]);
    const many = buttonsFromResults([
      {
        id: "3",
        name: "get_availability",
        output: {
          slots: Array.from({ length: 5 }, (_, i) => ({
            start: `t${i}`,
            label: `Mon 14 Sep, 1${i}:00`,
            staff_ids: ["a", "b"],
            service_id: "s",
          })),
        },
      },
    ]);
    expect(many.rows).toHaveLength(5);
    expect(many.rows?.[0].id).toBe("slot:t0|s|any");
    expect(many.rows?.[0].title.length).toBeLessThanOrEqual(20);
  });

  it("composes one outbound message", () => {
    expect(compose("hi", {})).toEqual([{ kind: "text", text: "hi" }]);
    expect(
      compose("pick", { buttons: [1, 2, 3, 4].map((i) => ({ id: `${i}`, title: `${i}` })) })[0],
    ).toMatchObject({ kind: "buttons" });
    expect(
      (
        compose("pick", {
          buttons: [1, 2, 3, 4].map((i) => ({ id: `${i}`, title: `${i}` })),
        })[0] as { buttons: unknown[] }
      ).buttons,
    ).toHaveLength(3);
    expect(compose(null, { rows: [{ id: "a", title: "A" }] })[0]).toMatchObject({
      kind: "list",
      text: "Choose an option:",
    });
    expect(compose(null, {})).toEqual([]);
  });
});

describe("scripted date parsing", () => {
  const today = "2026-09-12"; // Saturday
  it.each([
    ["today", "2026-09-12"],
    ["tomorrow please", "2026-09-13"],
    ["on tuesday", "2026-09-15"],
    ["saturday", "2026-09-19"],
    ["2026-10-01 at 10", "2026-10-01"],
    ["sometime", undefined],
  ])("%s -> %s", (text, expected) => {
    expect(parseDate(text, today)).toBe(expected);
  });
});

describe("anthropic mapping", () => {
  it("turns the neutral transcript into MessageParams", () => {
    const msgs = toMessages([
      { role: "user", text: "hi" },
      {
        role: "assistant",
        text: "let me check",
        toolCalls: [{ id: "t1", name: "list_services", input: {} }],
      },
      { role: "tool", results: [{ id: "t1", name: "list_services", output: { services: [] } }] },
      { role: "assistant", text: null, toolCalls: [] },
    ]);
    expect(msgs[0]).toEqual({ role: "user", content: "hi" });
    expect(msgs[1].role).toBe("assistant");
    expect((msgs[1].content as { type: string }[]).map((b) => b.type)).toEqual([
      "text",
      "tool_use",
    ]);
    expect((msgs[2].content as { type: string; tool_use_id: string }[])[0]).toMatchObject({
      type: "tool_result",
      tool_use_id: "t1",
    });
    expect((msgs[3].content as { type: string }[]).length).toBe(1);
  });

  it("reads text and tool calls out of a Message, and maps refusals", () => {
    const base = {
      id: "m",
      type: "message",
      role: "assistant",
      model: "x",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    };
    const r = fromResponse({
      ...base,
      stop_reason: "tool_use",
      content: [
        { type: "text", text: "ok" },
        {
          type: "tool_use",
          id: "t",
          name: "get_availability",
          input: { service_id: "s", date: "2026-09-15" },
        },
      ],
    } as unknown as Anthropic.Message);
    expect(r).toMatchObject({ text: "ok", stop: "tool" });
    expect(r.toolCalls[0]).toMatchObject({ id: "t", name: "get_availability" });
    const refusal = fromResponse({
      ...base,
      stop_reason: "refusal",
      content: [],
    } as unknown as Anthropic.Message);
    expect(refusal.stop).toBe("refusal");
    expect(refusal.text).toBeTruthy();
  });
});

describe("spread", () => {
  it("samples evenly including both ends", () => {
    expect(spread([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 4)).toEqual([1, 4, 7, 10]);
    expect(spread([1, 2], 4)).toEqual([1, 2]);
  });
});
