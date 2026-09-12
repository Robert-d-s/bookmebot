# Learning note 04: WhatsApp channel and the simulator

The bot now has a mouth and ears. WhatsApp is wired end to end, and a simulator channel
in the dashboard lets you hold a conversation with the bot with no Meta account at all.

## Shape

```
src/server/channels/
  types.ts              InboundMessage / OutboundMessage / Transport
  inbound.ts            phone -> customer, log IN, respond(), send, log OUT
  transports.ts         SIMULATOR (store only) and WHATSAPP (Graph API); swappable
  whatsapp/parse.ts     Meta webhook payload -> events (messages + statuses)
  whatsapp/api.ts       POST /{phone_number_id}/messages; text, buttons, list
  whatsapp/provider.ts  signature (X-Hub-Signature-256), GET challenge, handler
src/server/conversation/respond.ts   entry point of the conversation layer (learning note 05)
src/app/dashboard/simulator/         the chat page; each send is a signed webhook
src/app/dashboard/customers/[id]/    bookings + message thread per customer
scripts/tick.ts                      local scheduler (`pnpm tick --watch`)
```

## How a WhatsApp message becomes a reply

```
Meta POST /api/webhooks/whatsapp   (X-Hub-Signature-256 over the raw body)
  ingest: delivery row, one event per message and per status, 200
  after(): processEvent -> whatsappHandler
    business by metadata.phone_number_id        (businesses.whatsapp_phone_number_id)
    handleInboundMessage
      customer by (business, "+" + from)         created on first contact, name from contacts[]
      messages IN                                unique on (channel, wamid)
      respond() -> [OutboundMessage]
      whatsappTransport.send -> Graph API        returns wamid of the sent message
      messages OUT                               with that wamid
```

The simulator path is identical from `ingest` onward; the delivery is built and signed
by the dashboard action instead of by Meta, and the transport stores instead of sends.

## Things to notice

- **Phones.** Meta sends `40721000001`; we store `+40721000001` everywhere (E.164), so the
  same customer row serves WhatsApp, the simulator and the dashboard.
- **Reply buttons carry ids, not text.** `menu:hours`, `service:<uuid>`. The responder
  switches on ids for replies and on words only for free text. Phase 5's tool calls will
  do the same: ids are the API, titles are for humans.
- **WhatsApp limits** (3 buttons, 20-char titles, 10 rows, 24-char row titles) are
  enforced in `toGraphPayload`, not in the responder, so the responder can be generous
  and the edge trims.
- **Failed sends are retries.** If the Graph API errors (expired token is the classic),
  `sendWhatsApp` throws, the handler's outcome is `retry`, and the event goes through the
  backoff from phase 2. The IN message is already logged, so nothing is lost; the reply
  is sent when the token is fixed and the event is replayed.

## Test locally before deploying

Everything below runs on the laptop with Docker Postgres and no external accounts.

```bash
pnpm db:up && pnpm db:migrate && pnpm db:seed
pnpm dev                                    # terminal 1: http://localhost:3000
pnpm tick --watch                           # terminal 2: the scheduler, every 30 s
```

1. Sign in at `/login` (owner@frizeria.demo / demo-password).
2. **Simulator**: say "hi", tap "Opening hours", say "prices", tap a service. Every
   exchange is also visible under **Events** (provider `simulator`) and under the
   customer's page.
3. **Retry path**: on Settings, deactivate every staff member, then in the simulator
   send a `booking.requested` style event with curl (learning note 02) and watch it go
   SKIPPED; or stop Postgres for a moment during a send to see FAILED then PROCESSED
   after the tick.
4. **WhatsApp payloads without Meta**: with `WHATSAPP_APP_SECRET` set in `.env`, post a
   fixture like the one in `tests/unit/whatsapp.test.ts` to
   `/api/webhooks/whatsapp` signed with `openssl dgst -sha256 -hmac "$WHATSAPP_APP_SECRET"`.
   The reply attempt will fail (no access token), the event goes FAILED with the reason,
   and "replay now" on the Events page re-runs it once a token exists.
5. **Production build**: `pnpm build && pnpm start` is what Vercel runs.

## Connecting a real test number (when you want to)

Meta for Developers, create an app, add WhatsApp. On "API Setup" you get a test number,
a temporary access token and the phone number id; add up to 5 recipient numbers. Set
`WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_ACCESS_TOKEN`,
`WHATSAPP_PHONE_NUMBER_ID` (then `pnpm db:seed` to store the id on the demo business).
Webhook URL: `https://<app>/api/webhooks/whatsapp`, subscribe to `messages`. For a local
tunnel use any free tunnel (Cloudflare `cloudflared tunnel --url localhost:3000`).

## Self-test

1. A WhatsApp message is delivered twice, 30 seconds apart. Where is the second copy stopped, and why are there two guards?
2. Why does the simulator go through `ingest` instead of calling `handleInboundMessage` directly?
3. The Graph API token expires and three customers write in. What is the state of the events table, and what does the owner do?
4. Where would read receipts be implemented if the product needed them?
5. Why are reply ids like `service:<uuid>` a better contract for the AI layer than titles?
