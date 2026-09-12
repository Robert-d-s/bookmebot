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

| ADR                                           | Title                                                           |
| --------------------------------------------- | --------------------------------------------------------------- |
| [000](000-backend-inside-nextjs.md)           | Backend lives inside Next.js, no separate API service           |
| [001](001-db-level-double-booking-guard.md)   | Exclusion constraints, not unique indexes, guard double-booking |
| [002](002-advisory-lock-serialises-writes.md) | One advisory lock per business serialises booking writes        |
