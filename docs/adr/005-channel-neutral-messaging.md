# ADR-005: Channel-neutral messages, one log, simulator traffic through the webhook layer

Status: accepted
Date: 2026-09-12

## Context

The product's channel is WhatsApp, which needs a Meta developer account, a test number
and, for anything beyond messaging your own phones, template approval. None of that is
available on a fresh clone, in CI, or during a demo without network. The conversation
layer (phase 5) and the dashboard's message log must still be buildable and testable.

## Decision

- **Channel-neutral message types** (`channels/types.ts`): `InboundMessage` (text,
  button reply, list reply, unsupported) and `OutboundMessage` (text, up to 3 buttons,
  list). WhatsApp's payloads are mapped to and from these at the edge
  (`whatsapp/parse.ts`, `whatsapp/api.ts`). The conversation layer never sees a
  provider payload.
- **One inbound pipeline** (`channels/inbound.ts`): phone to customer (created on first
  contact), persist IN, ask `respond()`, send each reply through the channel's
  `Transport`, persist OUT. Both webhook handlers call it.
- **One `messages` table** for every channel and direction, with the provider message id
  unique per channel, so redelivery of a WhatsApp message is a no-op twice: once at the
  event level (ADR-003) and once here.
- **The simulator is a channel, not a mock.** The dashboard's chat page builds a signed
  simulator webhook delivery and pushes it through `ingest` and `processEvent`. What the
  owner sees in the chat has travelled the same code path as WhatsApp traffic; the only
  difference is the transport, which for the simulator stores the reply instead of
  calling the Graph API.
- **Transports are swappable** (`setTransport`), which is how integration tests assert
  what would have been sent to WhatsApp without touching the network.

## Consequences

- A WhatsApp account is only needed to prove the last inch (Meta's signature, the Graph
  API call). Both are covered by unit tests with fixtures and a fake fetch, and the
  provider is registered even when unconfigured: it then refuses all traffic with 401.
- Delivery statuses (sent/delivered/read) are ingested as events and skipped. They are in
  the events table if ever needed for read receipts; nothing acts on them.
- The scripted responder in `conversation/respond.ts` is a placeholder with the final
  signature. Phase 5 replaces its body, not its callers.
- Media messages arrive as `unsupported` with the raw payload kept. Handling them is out
  of scope for the demo.
