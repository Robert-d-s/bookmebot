# Learning note 05: The AI conversation layer

The scripted responder from phase 4 is gone. In its place: an agent loop with tools,
run by either Claude or a rule engine, with the booking guarantees living in the tools.

## Shape

```
src/server/conversation/
  llm/types.ts        Turn, ToolDef, LlmRequest/Response, LlmClient
  llm/anthropic.ts    Claude via @anthropic-ai/sdk (manual loop, cached system prompt)
  llm/scripted.ts     rule engine with the same interface; default without a key
  llm/index.ts        getLlm(): env-driven, test-overridable
  tools.ts            list_services, get_opening_hours, get_availability,
                      propose_booking, confirm_booking, list_my_bookings,
                      cancel_booking, reschedule_booking, handoff
  prompt.ts           stable system (business, services, staff, hours, rules)
                      + volatile context (today, time, customer, upcoming)
  buttons.ts          tool results -> buttons/lists; taps -> sentences
  state.ts            conversations table: transcript + { turn, proposal }
  agent.ts            the loop: complete -> execute tools -> repeat (max 6)
  respond.ts          channel entry point (unchanged signature)
```

## One turn, step by step

```
customer: "book a haircut on tuesday"
  agent: turn = n+1; append user turn
  llm.complete -> tool_use list_services            (needs the id)
  execute -> { services: [...] }
  llm.complete -> tool_use get_availability(service_id, 2026-09-15)
  execute -> { total: 35, slots: 8 sampled }
  llm.complete -> text "Free times on Tuesday. Pick one:"   (no more tools)
  buttons.ts: get_availability result -> list of 8 rows  slot:<iso>|<service>|any
  compose -> one `list` message
customer taps "Tue 15 Sep 10:00"
  decodeReply -> "slot pick: 2026-09-15T07:00:00Z service=... staff=any (Tue 10:00)"
  llm -> propose_booking -> engine says free -> state.proposal = { id, turn: n+2, ... }
  llm -> "Shall I book Haircut on Tue 15 Sep 10:00 with Andrei? Reply yes to confirm."
  buttons: [Yes, book it] [No]
customer taps Yes  (turn n+3)
  llm -> confirm_booking(proposal_id) -> guard: proposal.turn (n+2) < n+3, fresh -> reserveSlot
  llm -> "Booked: Haircut on Tue 15 Sep 10:00 with Andrei."
```

The same sequence with `LLM_PROVIDER=anthropic` differs only in who decides which tool
to call and how the sentences are worded.

## Why the guard is a turn counter and not a prompt rule

"Ask before booking" in a prompt is advice. `confirm_booking` refusing when
`proposal.turn >= state.turn` is a fact: the proposal was created while handling one
customer message, and confirmation can only succeed while handling a later one. The
customer's reply sits between them by construction. `tests/integration/conversation.test.ts`
has a test that calls the tools directly and shows the same-turn confirm being refused.

## Zero spend, still real

`ScriptedLlm` decides with regexes and reads the transcript to remember the service and
the pending proposal, then calls the real tools. So the free path exercises availability,
the proposal guard, the reserve transaction, cancel, and the button plumbing. What it
cannot do is understand "the day after tomorrow-ish around lunch". That is what the
Claude path is for, and it is a config switch:

```bash
ANTHROPIC_API_KEY=sk-ant-...   # LLM_PROVIDER defaults to anthropic when set
LLM_MODEL=claude-haiku-4-5     # optional; default claude-opus-5
```

## Try it

Dashboard, Simulator. "hi", tap Book, "haircut", "tuesday", tap a time, tap Yes. Then
"cancel", tap the booking. Open Events to see each message as a webhook event, and the
customer page to pause the bot (what `handoff` does) and resume it.

## Self-test

1. What stops the model from calling `confirm_booking` twice for the same proposal?
2. The customer taps a slot, waits 40 minutes, then taps Yes. What happens and why?
3. Why does `get_availability` return a sample of 8 starts instead of all 35?
4. Where would a Groq or Ollama client go, and what would it have to implement?
5. Why is the transcript stored in the neutral `Turn` format rather than the SDK's `MessageParam`?
