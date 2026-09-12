# ADR-006: The model proposes, the engine decides; one loop for any brain

Status: accepted
Date: 2026-09-12

## Context

Customers book by chat. An LLM is the natural interpreter, but three constraints shape
the design: the project must run with zero spend (CI, demos, fresh clones), the model
must never be able to "book" something that is not actually free, and the WhatsApp
surface wants buttons and lists, not prose.

## Decision

**A provider-neutral loop** (`conversation/agent.ts`) with a tiny `LlmClient`
interface: `complete(system, context, tools, turns) -> text | tool calls`. The
transcript is stored in that neutral shape, so history survives a provider switch.
Two clients:

- `AnthropicLlm`: Claude via the official SDK, manual tool loop, stable system prompt
  cached, `effort: low` because this is chat.
- `ScriptedLlm`: a rule engine wearing the same interface. It emits the same tool calls
  a model would (list services, get availability, propose, confirm, cancel). It is the
  default without an API key, and what CI runs. It is not a mock: it drives the real
  tools against the real engine.

**Tools, not prompt rules, carry the guarantees** (`conversation/tools.ts`):

1. Booking is two tools. `propose_booking` checks the slot with the engine and records a
   proposal in conversation state with the current customer-turn number.
   `confirm_booking` refuses unless the proposal exists, is under 30 minutes old, and was
   made in an _earlier_ customer turn. So the customer has always seen and answered the
   proposal before a row is written, no matter what the model says.
2. Every write is the phase 1 engine call. A slot that just went is a `ToolError` the
   model has to relay, never a booking.
3. Cancel and reschedule look the booking up by id _and_ customer id.
4. `handoff` flips the conversation to HUMAN mode; the agent then returns nothing until
   the owner resumes it from the dashboard.

**Buttons are the API between UI and model** (`conversation/buttons.ts`). Ids are
machine-readable (`slot:<iso>|<service>|<staff>`, `confirm:<proposal>`, `cancel:<id>`);
a tap is decoded into a sentence the model understands. Buttons and lists are derived
from tool results, so the model never has to format them.

## Consequences

- Swapping the brain is an env var. A third client, `OpenAiCompatibleLlm`, speaks the
  chat-completions wire format and covers the free tiers (Groq, Google AI Studio,
  OpenRouter `:free` models) and a local Ollama, so real LLM calls are possible at zero
  cost. Quality varies by model; the Anthropic path is the reference.
- The scripted brain is narrow by design (book, cancel, hours, prices, greeting). Its job
  is to prove the loop and the guardrails, not to understand language.
- The system prompt lists services and staff with ids, so the model can call tools
  without a lookup round trip; the volatile part (date, customer, upcoming bookings) is a
  second system block after the cache breakpoint.
- Transcripts are trimmed to the last 40 turns; there is no summarisation. Enough for a
  booking conversation, revisit if threads get long.
- Costs with Claude: a booking conversation is roughly 6-10 requests of a few thousand
  cached tokens, cents at Opus prices, less on Haiku (`LLM_MODEL`).
