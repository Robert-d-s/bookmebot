# ADR-000: Backend lives inside Next.js, no separate API service

Status: accepted
Date: 2026-09-12

## Context

The target stack names "Next.js App Router (route handlers, server actions)" as the backend
surface. A separate NestJS service would be familiar but would need a second free host
(which sleeps on free tiers), duplicate auth wiring, and diverge from the stack being
demonstrated.

## Decision

All server code lives in the Next.js app:

- `src/app/api/**/route.ts`: inbound HTTP (webhooks, cron, health). These are the
  "controllers".
- Server actions in `src/app/(dashboard)`: mutations from the owner UI.
- `src/server/<domain>/`: plain TypeScript modules, organised like NestJS modules
  (`service.ts` with logic, `repository.ts` with Prisma queries) but with no decorators
  and no DI container. Dependencies are function parameters.

Because Vercel functions are short-lived, there is no in-memory queue or scheduler.
Background work is persisted (outbox / inbound event tables) and drained by cron routes.

## Consequences

- One deploy, one codebase, one set of env vars.
- The domain layer is testable without HTTP: tests call `src/server` functions directly.
- Anything that needs a long-running process (websockets, in-memory workers) is out of
  scope by design; the outbox pattern replaces it.
