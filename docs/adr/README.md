# Architecture Decision Records

One file per decision that is not obvious from the code. Format:

```
# ADR-NNN: Title
Status: accepted | superseded by ADR-MMM
Date: YYYY-MM-DD

## Context
## Decision
## Consequences
```

| ADR                                                 | Title                                                                          |
| --------------------------------------------------- | ------------------------------------------------------------------------------ |
| [000](000-backend-inside-nextjs.md)                 | Backend lives inside Next.js, no separate API service                          |
| [001](001-db-level-double-booking-guard.md)         | Exclusion constraints, not unique indexes, guard double-booking                |
| [002](002-advisory-lock-serialises-writes.md)       | One advisory lock per business serialises booking writes                       |
| [003](003-inbound-webhooks-persist-then-process.md) | Inbound webhooks are persisted first, processed second, claimed by status      |
| [004](004-credentials-auth-jwt-sessions.md)         | Credentials login with JWT sessions, guarded in the proxy                      |
| [005](005-channel-neutral-messaging.md)             | Channel-neutral messages, one log, simulator traffic through the webhook layer |
| [006](006-llm-proposes-engine-decides.md)           | The model proposes, the engine decides; one loop for any brain                 |
| [007](007-deposits-as-holds.md)                     | Deposits are holds; Stripe events drive state; a fake gateway keeps it local   |
| [008](008-calendar-sync-by-version.md)              | Calendar push keyed on booking version; pulled time becomes engine blocks      |
| [009](009-row-level-security.md)                    | RLS on every table; a tenant role scoped by a transaction setting              |
